/**
 * Stripe Usage Record Queue flush サービス (PR-S6 / 2026-05-14)
 *
 * 役割:
 *   `stripe_usage_record_queue` から未送信 (sentAt=null) かつ送信予定時刻が到来した行を
 *   取り出し、Stripe Subscription Item に Usage Record として送信する。
 *   5 分間隔の Vercel Cron (`/api/cron/stripe-usage-flush`) から呼ばれる。
 *
 * 設計方針 (STRIPE_BILLING.md §6.1 / schema StripeUsageRecordQueue 周辺):
 *   - **非同期送信**: withMeteredLLM の同期送信を避け、LLM 呼出 → queue 投入 → cron で Stripe へ
 *   - **idempotency_key**: `usage:{subscriptionItemId}:{apiCallLogId}` で Stripe 側でも重複防止
 *   - **exponential backoff**: 1, 5, 15, 60, 240 分 → 5 回失敗で DLQ (nextSendAt=null)
 *   - **DLQ 入りは super_admin が手動再投入**: 本サービスは DLQ 行を無視する
 *   - **batch サイズ上限**: 1 回の cron 実行で 500 件まで処理 (= Vercel function timeout 対策)
 *
 * 関連:
 *   - 仕様: docs/business/STRIPE_BILLING.md §6.1 / §4.2 (通常運用フロー)
 *   - スキーマ: prisma/schema.prisma model StripeUsageRecordQueue
 *   - 元データ: withMeteredLLM (= src/lib/llm/metered.ts) が credit_card テナントの呼出時に enqueue
 *   - Stripe API ラッパー: reportUsage (= src/services/stripe-billing.service.ts)
 */

import { prisma } from '@/lib/db';
import { isStripeEnabled } from '@/lib/stripe';
import { reportUsage } from './stripe-billing.service';

/** 1 回の cron 実行で処理する最大件数 (Vercel function timeout 対策)。 */
const FLUSH_BATCH_SIZE = 500;

/**
 * 送信失敗時の retry backoff (分)。配列 index が retryCount に対応。
 * 5 回目失敗 (index 4) で nextSendAt=null → DLQ 入り。
 */
const RETRY_BACKOFF_MINUTES = [1, 5, 15, 60, 240] as const;

export type FlushStripeUsageResult = {
  /** 処理対象として取り出した件数 (= 候補件数) */
  candidates: number;
  /** Stripe に送信成功した件数 */
  succeeded: number;
  /** Stripe 送信失敗 + リトライ予定として記録した件数 */
  failed: number;
  /** subscriptionItemId 不明 / 5 回失敗で DLQ 入りした件数 */
  dlq: number;
  /** Stripe 無効 (feature flag off / 環境変数不足) でスキップ */
  skipped: boolean;
};

/**
 * Queue から未送信 + 送信予定時刻到来の行を取り出して、Stripe Usage Record として送信。
 *
 * フロー:
 *   1. `STRIPE_ENABLED=false` なら早期 return (skipped=true)
 *   2. 候補抽出: `sentAt=null AND nextSendAt != null AND nextSendAt <= now` (= 送信可能)
 *      tenant relation も同時取得 (= callType → subscriptionItemId 解決のため)
 *   3. 各候補について:
 *      a. subscriptionItemId 不明なら DLQ (lastError 付き、nextSendAt=null)
 *      b. reportUsage 呼出 → 成功なら sentAt=now、失敗なら retryCount++ + backoff or DLQ
 *
 * 冪等性:
 *   - 同一 apiCallLogId は Stripe 側で idempotency_key により重複処理されない
 *   - cron が 2 回連続走行しても、sentAt=null かつ nextSendAt 到来が条件なので
 *     1 回目で sentAt セット済の行は 2 回目で拾わない
 */
export async function flushStripeUsageRecordQueue(): Promise<FlushStripeUsageResult> {
  if (!isStripeEnabled()) {
    return { candidates: 0, succeeded: 0, failed: 0, dlq: 0, skipped: true };
  }

  const now = new Date();

  // 候補抽出 (= 送信可能な行)
  const candidates = await prisma.stripeUsageRecordQueue.findMany({
    where: {
      sentAt: null,
      nextSendAt: { not: null, lte: now },
    },
    include: {
      tenant: {
        select: {
          stripeSubscriptionItemHaikuId: true,
          stripeSubscriptionItemSonnetId: true,
        },
      },
    },
    take: FLUSH_BATCH_SIZE,
    // 古い順 (= 月境界の整合性のため、occurredAt 古いものから送る)
    orderBy: { occurredAt: 'asc' },
  });

  let succeeded = 0;
  let failed = 0;
  let dlq = 0;

  for (const row of candidates) {
    // callType → subscriptionItemId の解決
    const itemId =
      row.callType === 'sonnet'
        ? row.tenant.stripeSubscriptionItemSonnetId
        : row.tenant.stripeSubscriptionItemHaikuId;

    if (itemId == null) {
      // テナント設定不整合 (= setup 未完了 / 解約後 など)。DLQ 入りで運用調査。
      await prisma.stripeUsageRecordQueue.update({
        where: { id: row.id },
        data: {
          nextSendAt: null,
          lastError: `Stripe SubscriptionItem ID is null for callType=${row.callType}`,
        },
      });
      dlq++;
      continue;
    }

    const result = await reportUsage({
      subscriptionItemId: itemId,
      quantity: row.quantity,
      occurredAt: row.occurredAt,
      apiCallLogId: row.apiCallLogId,
    });

    if (result.ok) {
      await prisma.stripeUsageRecordQueue.update({
        where: { id: row.id },
        data: {
          sentAt: new Date(),
          nextSendAt: null,
          lastError: null,
        },
      });
      succeeded++;
    } else {
      const nextRetryCount = row.retryCount + 1;
      const backoffMin = RETRY_BACKOFF_MINUTES[nextRetryCount - 1];
      const nextSendAt =
        backoffMin != null ? new Date(Date.now() + backoffMin * 60_000) : null;

      await prisma.stripeUsageRecordQueue.update({
        where: { id: row.id },
        data: {
          retryCount: nextRetryCount,
          nextSendAt,
          // result の userMessage が一定長 (= UI 向け短文) なのでそのまま保存
          lastError: result.userMessage,
        },
      });
      if (nextSendAt == null) dlq++;
      else failed++;
    }
  }

  return {
    candidates: candidates.length,
    succeeded,
    failed,
    dlq,
    skipped: false,
  };
}
