/**
 * 診断ダッシュボード集約サービス (PR-V8 / 2026-05-19)
 *
 * 役割:
 *   super_admin が「人間が想定していない事象が起きたときに何が起きているかを画面上で理解」
 *   できるよう、システム全体の健全性を 1 箇所に集約する。
 *   `/admin/super/diagnostics` ページの Server Component から呼ばれる。
 *
 *   個別の検査ロジックは各 service に委譲:
 *     - API drift 検知: api-usage-recalc.service.ts (reconcileAllTenantsApiUsage)
 *     - cron 健全性: cron-health.service.ts (checkAllCronHealth)
 *     - メール送信失敗: email-send-log.service.ts (getRecentFailedEmails)
 *     - 縮退モードテナント: tenant.findMany (本 service 内、軽量 query)
 *     - alert 機構の空打ち: system_error_logs (kind='admin_alert_no_recipients')
 *     - audit_log silent fail: system_error_logs (severity='error', source='server' で uuid 違反)
 *
 * 設計判断:
 *   - **本 service は集約のみ**: 個別ロジックを持たず、各 service の結果を組み合わせるだけ。
 *     テスト容易性を保ち、責務を分離する。
 *   - **異常件数を totalAnomalies で 1 整数化**: top page の赤バナーで「⚠️ N 件の異常」表示用。
 *   - **すべて Server Component 経由を想定**: Client Component には DiagnosticsSummary 型 (= 値のみ)
 *     を JSON 経由で渡す。Prisma instance を Client bundle に混入させない。
 *
 * 関連:
 *   - 画面: src/app/(dashboard)/admin/super/diagnostics/page.tsx
 *   - top バナー: src/app/(dashboard)/admin/super/page.tsx
 */

import { prisma } from '@/lib/db';
import {
  reconcileAllTenantsApiUsage,
  type ApiUsageReconcileResult,
} from './api-usage-recalc.service';
import {
  checkAllCronHealth,
  type CronHealthRow,
} from './cron-health.service';
import {
  getRecentFailedEmails,
  type RecentFailedEmail,
} from './email-send-log.service';

// ================================================================
// 公開型
// ================================================================

/** 縮退モードに突入しているテナントの概要 (DegradedModeState の軽量版)。 */
export type DegradedTenantSummary = {
  tenantId: string;
  tenantName: string;
  plan: string;
  reason: 'beginner_limit_exceeded' | 'budget_exceeded';
  currentMonthApiCallCount: number;
  currentMonthApiCostJpy: number;
  beginnerMonthlyCallLimit: number | null;
  monthlyBudgetCapJpy: number | null;
};

/**
 * PR-V8.1 (2026-05-19) ★請求重要★: Stripe Usage Record 送信滞留 / DLQ。
 *
 * `StripeUsageRecordQueue` で `sentAt=null` のレコードは以下のいずれか:
 *   - delayed: `nextSendAt < now() - 24h` (= 24h 以上送信遅延、cron 障害等)
 *   - dlq: `nextSendAt = null` (= リトライ上限到達、永続的失敗)
 *
 * いずれも **Stripe 側で請求書に反映されない = 請求漏れ** に直結。
 * 個人の貯金から負担になる致命傷のため診断ダッシュボードで監視必須。
 */
export type StripeUsageQueueIssue = {
  category: 'delayed' | 'dlq';
  count: number;
  /** 滞留 / DLQ 行の中の代表サンプル (古い順、最大 10 件) */
  samples: Array<{
    id: string;
    tenantId: string;
    callType: string;
    occurredAt: Date;
    retryCount: number;
    lastError: string | null;
  }>;
};

/** alert 機構の空打ち警告 (super_admin 通知メールが宛先 0 で送れなかった履歴)。 */
export type AlertNoRecipientWarning = {
  recordedAt: Date;
  message: string;
  context: Record<string, unknown> | null;
};

/** 診断ダッシュボードに表示する全データを集約した型。 */
export type DiagnosticsSummary = {
  /** 検査時刻 */
  measuredAt: Date;
  /** すべてのカテゴリの異常件数の合計 (top page の赤バナーで「N 件の異常」表示用) */
  totalAnomalies: number;

  /** API 利用量 drift: counter と ApiCallLog SUM が乖離しているテナント */
  driftedTenants: ApiUsageReconcileResult[];

  /** cron 健全性: 全 cron の状態 (= healthy / stale / never_recorded) */
  cronHealth: CronHealthRow[];

  /** 縮退モード突入テナント */
  degradedTenants: DegradedTenantSummary[];

  /** 直近 24h で送信失敗したメール (上位 50 件) */
  recentFailedEmails: RecentFailedEmail[];

  /** super_admin alert が宛先 0 で送れなかった警告 (直近 7 日) */
  alertNoRecipientWarnings: AlertNoRecipientWarning[];

  /**
   * PR-V8.1 (2026-05-19) ★請求重要★: Stripe Usage Record 滞留 / DLQ。
   * 0 件配列なら正常、1 件以上で「請求漏れ」リスクとして赤強調表示する。
   */
  stripeUsageQueueIssues: StripeUsageQueueIssue[];
};

// ================================================================
// 公開関数
// ================================================================

/**
 * 診断ダッシュボードの全データを集約取得する。
 *
 * `Promise.all` で並列実行するため、各 service の重さに引きずられない。
 * 個別 service の例外は呼出側に伝播するが、ダッシュボードは super_admin のみ閲覧する
 * read-only 画面のため、ユーザ影響は限定的 (= エラー時は 500 表示で OK)。
 */
export async function getDiagnosticsSummary(
  now: Date = new Date(),
): Promise<DiagnosticsSummary> {
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [
    reconciles,
    cronHealth,
    degradedTenants,
    recentFailedEmails,
    alertNoRecipientWarnings,
    stripeUsageQueueIssues,
  ] = await Promise.all([
    reconcileAllTenantsApiUsage(now),
    checkAllCronHealth(now),
    listDegradedTenants(),
    getRecentFailedEmails(24, 50, now),
    listAlertNoRecipientWarnings(sevenDaysAgo),
    listStripeUsageQueueIssues(now),
  ]);

  const driftedTenants = reconciles.filter((r) => r.hasDrift);
  const stripeIssueRowCount = stripeUsageQueueIssues.reduce((s, i) => s + i.count, 0);

  const totalAnomalies =
    driftedTenants.length
    + cronHealth.filter((c) => c.isUnhealthy).length
    + degradedTenants.length
    + (recentFailedEmails.length > 0 ? 1 : 0) // 失敗メールは 1 カテゴリ = 1 件カウント
    + alertNoRecipientWarnings.length
    + (stripeIssueRowCount > 0 ? 1 : 0); // Stripe queue 滞留も 1 カテゴリ = 1 件カウント

  return {
    measuredAt: now,
    totalAnomalies,
    driftedTenants,
    cronHealth,
    degradedTenants,
    recentFailedEmails,
    alertNoRecipientWarnings,
    stripeUsageQueueIssues,
  };
}

/**
 * 縮退モードに突入しているテナント一覧を取得する。
 *
 * 重い `getDegradedModeState` (各テナントで countNullEmbeddings まで実行) を全件で呼ぶと
 * N+1 になるため、ここでは Tenant 1 query + 軽量 client-side filter で求める。
 */
export async function listDegradedTenants(): Promise<DegradedTenantSummary[]> {
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      name: true,
      plan: true,
      currentMonthApiCallCount: true,
      currentMonthApiCostJpy: true,
      beginnerMonthlyCallLimit: true,
      monthlyBudgetCapJpy: true,
    },
  });

  const result: DegradedTenantSummary[] = [];
  for (const t of tenants) {
    if (t.plan === 'beginner') {
      if (t.currentMonthApiCallCount >= t.beginnerMonthlyCallLimit) {
        result.push({
          tenantId: t.id,
          tenantName: t.name,
          plan: t.plan,
          reason: 'beginner_limit_exceeded',
          currentMonthApiCallCount: t.currentMonthApiCallCount,
          currentMonthApiCostJpy: t.currentMonthApiCostJpy,
          beginnerMonthlyCallLimit: t.beginnerMonthlyCallLimit,
          monthlyBudgetCapJpy: t.monthlyBudgetCapJpy,
        });
      }
    } else if (t.monthlyBudgetCapJpy != null) {
      if (t.currentMonthApiCostJpy >= t.monthlyBudgetCapJpy) {
        result.push({
          tenantId: t.id,
          tenantName: t.name,
          plan: t.plan,
          reason: 'budget_exceeded',
          currentMonthApiCallCount: t.currentMonthApiCallCount,
          currentMonthApiCostJpy: t.currentMonthApiCostJpy,
          beginnerMonthlyCallLimit: null,
          monthlyBudgetCapJpy: t.monthlyBudgetCapJpy,
        });
      }
    }
  }
  return result;
}

/**
 * super_admin alert が宛先 0 で送れなかった warning を取得する。
 *
 * `admin-alert.service.ts:sendSuperAdminAlert` が recordError(kind='admin_alert_no_recipients')
 * を呼んだ履歴を直近 7 日で取得し、alert 機構自体の健全性を担保する。
 */
/**
 * PR-V8.1 (2026-05-19) ★請求重要★: Stripe Usage Record 送信滞留 / DLQ を取得。
 *
 * - delayed: `sentAt IS NULL AND nextSendAt < now() - 24h` (= 24h 以上送信遅延)
 * - dlq: `sentAt IS NULL AND nextSendAt IS NULL` (= リトライ上限到達)
 *
 * いずれも Stripe 側で請求書に反映されない = **請求漏れ = 個人の貯金から負担** に直結。
 */
export async function listStripeUsageQueueIssues(
  now: Date = new Date(),
): Promise<StripeUsageQueueIssue[]> {
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [delayed, dlq] = await Promise.all([
    prisma.stripeUsageRecordQueue.findMany({
      where: {
        sentAt: null,
        nextSendAt: { not: null, lt: twentyFourHoursAgo },
      },
      orderBy: { occurredAt: 'asc' },
      take: 10,
      select: {
        id: true,
        tenantId: true,
        callType: true,
        occurredAt: true,
        retryCount: true,
        lastError: true,
      },
    }),
    prisma.stripeUsageRecordQueue.findMany({
      where: { sentAt: null, nextSendAt: null },
      orderBy: { occurredAt: 'asc' },
      take: 10,
      select: {
        id: true,
        tenantId: true,
        callType: true,
        occurredAt: true,
        retryCount: true,
        lastError: true,
      },
    }),
  ]);
  const [delayedCount, dlqCount] = await Promise.all([
    prisma.stripeUsageRecordQueue.count({
      where: { sentAt: null, nextSendAt: { not: null, lt: twentyFourHoursAgo } },
    }),
    prisma.stripeUsageRecordQueue.count({
      where: { sentAt: null, nextSendAt: null },
    }),
  ]);
  const result: StripeUsageQueueIssue[] = [];
  if (delayedCount > 0) {
    result.push({ category: 'delayed', count: delayedCount, samples: delayed });
  }
  if (dlqCount > 0) {
    result.push({ category: 'dlq', count: dlqCount, samples: dlq });
  }
  return result;
}

export async function listAlertNoRecipientWarnings(
  since: Date,
): Promise<AlertNoRecipientWarning[]> {
  const rows = await prisma.systemErrorLog.findMany({
    where: {
      createdAt: { gte: since },
      source: 'cron',
      // context.kind == 'admin_alert_no_recipients' の絞り込みは JSONB index 未整備のため
      //   素朴に message LIKE で絞る (= recordError 時のメッセージで一意に判別可能)。
      message: { contains: 'admin-alert' },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      createdAt: true,
      message: true,
      context: true,
    },
  });
  return rows.map((r) => ({
    recordedAt: r.createdAt,
    message: r.message,
    context: (r.context as Record<string, unknown> | null) ?? null,
  }));
}
