/**
 * Stripe DLQ (Dead Letter Queue) 監視・再投入サービス (PR-V7 #6 / 2026-05-19)
 *
 * 役割:
 *   Stripe Webhook 処理失敗 (= `StripeWebhookEvent` retryCount 過大) と
 *   Stripe Usage Record 送信失敗 (= `StripeUsageRecordQueue` nextSendAt=null) の
 *   2 種類の DLQ を super_admin が監視・手動再投入できる経路を提供する。
 *
 * 解決する問題:
 *   PR-S4 / PR-S6 で実装した自動 retry はそれぞれ 4 回 / 6 回まで実施するが、
 *   それでも失敗が続く場合は DLQ に倒れて永久に放置される。請求漏れ / 顧客クレーム
 *   の根本原因になるため、手動リカバリ経路を必ず設ける。
 *
 * 設計方針:
 *   - **読み取り**: super_admin ダッシュボード ([/admin/super/stripe-dlq](src/app/(dashboard)/admin/super/stripe-dlq)) で
 *     未処理 webhook / DLQ webhook / DLQ usage queue 行を一覧化
 *   - **書き込み (= 再投入)**: 「再投入」ボタンで `retryCount` / `nextSendAt` を初期化 →
 *     既存 cron / Webhook 再受信に任せる (= 直接 Stripe API は叩かない)
 *   - **権限**: super_admin (= プラットフォーム運営者) のみ。route.ts 側で `requireSuperAdmin` 担保
 *   - **監査**: 再投入操作は auditLog に必ず記録 (= 誰がいつ何を再投入したか追跡可能に)
 *
 * 関連:
 *   - schema: prisma/schema.prisma model StripeWebhookEvent / StripeUsageRecordQueue
 *   - UI: src/app/(dashboard)/admin/super/stripe-dlq/page.tsx
 *   - API: src/app/api/admin/super/stripe-dlq/(webhook|usage)/[id]/retry/route.ts
 */

import { prisma } from '@/lib/db';

const LIST_LIMIT = 200;

// ============================================================
// 取得 (一覧表示用)
// ============================================================

export type WebhookDlqEntry = {
  id: string;
  type: string;
  receivedAt: Date;
  processedAt: Date | null;
  errorMessage: string | null;
  retryCount: number;
  nextRetryAt: Date | null;
  /** retryCount >= 4 AND nextRetryAt=null = DLQ 確定 */
  isDlq: boolean;
};

export type UsageQueueDlqEntry = {
  id: string;
  tenantId: string;
  callType: string;
  apiCallLogId: string;
  quantity: number;
  occurredAt: Date;
  retryCount: number;
  nextSendAt: Date | null;
  sentAt: Date | null;
  lastError: string | null;
  /** sentAt=null AND nextSendAt=null = DLQ 確定 */
  isDlq: boolean;
};

/**
 * Webhook DLQ 一覧 (= 未処理 + DLQ 入り両方を返却)。
 * UI で「処理中 / DLQ 確定」を見分けたいので isDlq フラグを付与。
 */
export async function listWebhookDlq(): Promise<{ entries: WebhookDlqEntry[]; totalDlq: number; totalUnprocessed: number }> {
  const rows = await prisma.stripeWebhookEvent.findMany({
    where: { processedAt: null },
    orderBy: [{ retryCount: 'desc' }, { receivedAt: 'desc' }],
    take: LIST_LIMIT,
    select: {
      id: true,
      type: true,
      receivedAt: true,
      processedAt: true,
      errorMessage: true,
      retryCount: true,
      nextRetryAt: true,
    },
  });
  const entries: WebhookDlqEntry[] = rows.map((r) => ({
    ...r,
    isDlq: r.retryCount >= 4 && r.nextRetryAt == null,
  }));
  const totalDlq = entries.filter((e) => e.isDlq).length;
  const totalUnprocessed = entries.length - totalDlq;
  return { entries, totalDlq, totalUnprocessed };
}

/**
 * Usage Record Queue DLQ 一覧 (= 未送信 + DLQ 入り両方を返却)。
 */
export async function listUsageQueueDlq(): Promise<{ entries: UsageQueueDlqEntry[]; totalDlq: number; totalPending: number }> {
  const rows = await prisma.stripeUsageRecordQueue.findMany({
    where: { sentAt: null },
    orderBy: [{ retryCount: 'desc' }, { occurredAt: 'desc' }],
    take: LIST_LIMIT,
    select: {
      id: true,
      tenantId: true,
      callType: true,
      apiCallLogId: true,
      quantity: true,
      occurredAt: true,
      retryCount: true,
      nextSendAt: true,
      sentAt: true,
      lastError: true,
    },
  });
  const entries: UsageQueueDlqEntry[] = rows.map((r) => ({
    ...r,
    isDlq: r.sentAt == null && r.nextSendAt == null,
  }));
  const totalDlq = entries.filter((e) => e.isDlq).length;
  const totalPending = entries.length - totalDlq;
  return { entries, totalDlq, totalPending };
}

// ============================================================
// 書き込み (再投入)
// ============================================================

export type RetryResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Webhook event を再投入 (= retryCount リセット + nextRetryAt = now)。
 *
 * 設計判断:
 *   - retryCount を 0 にリセット (= 4 回 / 5 回目以降の自動 retry を再開)
 *   - nextRetryAt を現在時刻にセット (= Stripe の自動再送に頼らず即時 retry 候補に)
 *   - 本サービス自体は Stripe を再呼出しない (= Stripe 側からの再 POST を待つ運用)
 *
 * 注: Stripe は元々 3 日間自動再送するため、それを超えた DLQ は Stripe 側からは
 *   再送されない。実質的に再投入する経路は「Stripe Dashboard で event manual replay」
 *   または「super_admin が手動で Stripe Dashboard から該当 event を再送」となる。
 *   本関数は DB 側のメタデータをリセットして「次回 Stripe 再送時に処理される状態」にする。
 */
export async function retryWebhookEvent(
  eventId: string,
  performerId: string,
): Promise<RetryResult> {
  const existing = await prisma.stripeWebhookEvent.findUnique({
    where: { id: eventId },
    select: { id: true, processedAt: true, type: true, retryCount: true },
  });
  if (existing == null) {
    return { ok: false, error: 'EVENT_NOT_FOUND' };
  }
  if (existing.processedAt != null) {
    return { ok: false, error: 'ALREADY_PROCESSED' };
  }
  await prisma.$transaction([
    prisma.stripeWebhookEvent.update({
      where: { id: eventId },
      data: {
        retryCount: 0,
        nextRetryAt: new Date(),
        errorMessage: null,
      },
    }),
    prisma.auditLog.create({
      data: {
        // Webhook event は tenant 紐付けがない (= 全テナント横断 event の可能性) ので
        // 操作者のテナント (MANAGEMENT) を audit log の tenantId に流用。
        tenantId: performerId,
        userId: performerId,
        action: 'UPDATE',
        entityType: 'stripe_webhook_event',
        entityId: eventId,
        beforeValue: { retryCount: existing.retryCount, processedAt: null },
        afterValue: {
          retryCount: 0,
          action: 'dlq_manual_retry',
          eventType: existing.type,
        },
      },
    }),
  ]);
  return { ok: true, id: eventId };
}

/**
 * Usage Queue row を再投入 (= retryCount リセット + nextSendAt = now)。
 *
 * 次回 5 分 cron (= stripe-usage-flush) で再度 Stripe API へ送信される。
 * idempotency_key は元のままなので、二重送信にはならない (= Stripe 側で重複排除)。
 */
export async function retryUsageQueueRow(
  rowId: string,
  performerId: string,
): Promise<RetryResult> {
  const existing = await prisma.stripeUsageRecordQueue.findUnique({
    where: { id: rowId },
    select: { id: true, tenantId: true, sentAt: true, retryCount: true, apiCallLogId: true },
  });
  if (existing == null) {
    return { ok: false, error: 'ROW_NOT_FOUND' };
  }
  if (existing.sentAt != null) {
    return { ok: false, error: 'ALREADY_SENT' };
  }
  await prisma.$transaction([
    prisma.stripeUsageRecordQueue.update({
      where: { id: rowId },
      data: {
        retryCount: 0,
        nextSendAt: new Date(),
        lastError: null,
      },
    }),
    prisma.auditLog.create({
      data: {
        tenantId: existing.tenantId,
        userId: performerId,
        action: 'UPDATE',
        entityType: 'stripe_usage_record_queue',
        entityId: rowId,
        beforeValue: { retryCount: existing.retryCount, sentAt: null },
        afterValue: {
          retryCount: 0,
          action: 'dlq_manual_retry',
          apiCallLogId: existing.apiCallLogId,
        },
      },
    }),
  ]);
  return { ok: true, id: rowId };
}
