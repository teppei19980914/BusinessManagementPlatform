/**
 * Tenant 月次リセット サービス (PR #2-d / T-03 提案エンジン v2)
 *
 * 役割:
 *   1. **月初リセット**: 月初を跨いだテナントの API 呼び出しカウンタ + 課金額を 0 にリセット
 *   2. **プラン変更予約適用**: scheduledPlanChangeAt 到達テナントに scheduledNextPlan を反映
 *
 * Vercel Cron で毎月 1 日 00:00 UTC に実行される (vercel.json + /api/cron/tenant-monthly-reset)。
 *
 * 設計判断:
 *
 *   - **冪等性 (idempotency)**: cron が re-trigger されても結果は同じ。Vercel Cron は
 *     最低 1 回保証なので、複数回起動でも安全に動かなければならない。
 *     - 月初リセット: WHERE lastResetAt < currentMonthStart で絞るため、すでに当月分が
 *       適用済みのテナントは再 update しない (= 第 2 回目以降は 0 件)。
 *     - プラン変更適用: 適用後に scheduledPlanChangeAt と scheduledNextPlan を NULL に
 *       戻すため、再実行しても対象 0 件 (= 副作用なし)。
 *
 *   - **UTC ベース**: 月の境界はテナントごとの timezone に依存させず UTC で固定。
 *     ユーザ向け表示 (請求書等) は別途 localize する想定。これにより cron 実行時刻
 *     (UTC) と境界判定 (UTC) が一致し、タイムゾーン考慮ミスを避けられる。
 *
 *   - **scheduledNextPlan 検証**: DB に保存された値が壊れている場合 (将来の OS 変更等で)
 *     不正値が混入する可能性に備え、適用時点で `isTenantPlan` で検証。不正値はログ記録
 *     してスキップ (cron 全体は止めない)。
 *
 *   - **deletedAt フィルタ**: 削除済テナントは集計対象外。
 *
 *   - **トランザクションを使わない**: 月次リセットはテナントごとに独立した update であり、
 *     一括 transaction にすると 1 件失敗で全体 rollback になる。テナントごとに try/catch
 *     して結果を集計する方が運用上安全 (失敗 1 件で他全件のリセットを落とさない)。
 *
 * 関連:
 *   - cron endpoint: src/app/api/cron/tenant-monthly-reset/route.ts
 *   - スケジュール定義: vercel.json
 *   - 設計: docs/design/SUGGESTION_ENGINE.md §課金モデル
 *   - 計画: docs/roadmap/SUGGESTION_ENGINE_PLAN.md PR #2 章
 */

import { prisma } from '@/lib/db';
import { recordError } from '@/services/error-log.service';
import { isTenantPlan, MANAGEMENT_TENANT_ID } from '@/lib/tenant';

export interface TenantMonthlyResetResult {
  /** 月初リセット対象として update したテナント件数。 */
  resetCount: number;
  /** プラン変更を適用したテナント件数。 */
  planAppliedCount: number;
  /** scheduledNextPlan が不正値のため skip した件数 (DB 不整合検知)。 */
  invalidPlanSkippedCount: number;
  /** P-5b (2026-05-08): スナップショット保存件数 (= 履歴テーブルに insert した件数)。 */
  snapshotSavedCount: number;
}

/**
 * 当月の UTC 月初を返す (例: 2026-05-15T08:30:00Z → 2026-05-01T00:00:00Z)。
 */
export function getCurrentMonthStartUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * P-5b (2026-05-08): 当月初の前月を "YYYY-MM" 文字列で返す。
 *
 * 月初リセット cron で snapshot を保存する yearMonth は **リセット対象月の 1 つ前** で
 * ある (= 「2026-05-01 のリセット時点では、4 月分の使用量を確定して 4 月分として保存する」)。
 *
 * @param now 計算基準時刻 (実運用時は cron 起動時刻 = 当月初付近)
 * @returns "YYYY-MM" 形式 (例: 2026-05-15 を渡すと "2026-04")
 */
export function getPreviousYearMonth(now: Date = new Date()): string {
  // 当月初を取って 1 ms 引くと前月末になる、その UTC 年月を取り出す
  const currentMonthStart = getCurrentMonthStartUtc(now);
  const previousMonthInstant = new Date(currentMonthStart.getTime() - 1);
  const year = previousMonthInstant.getUTCFullYear();
  const month = previousMonthInstant.getUTCMonth() + 1; // 0-indexed → 1-indexed
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * P-5b (2026-05-08): 月次リセット **直前** に各テナントの当月使用量をスナップショット保存する。
 *
 * 動作:
 *   - 対象: deletedAt IS NULL AND id != MANAGEMENT_TENANT_ID AND
 *           (lastResetAt IS NULL OR lastResetAt < 当月初) — リセット対象と同じ条件
 *   - 保存: tenant_monthly_usage_history に (tenantId, yearMonth=前月) で upsert
 *   - 冪等性: (tenantId, yearMonth) unique 制約で二重実行時も 1 行のみに収束
 *
 * 注意:
 *   この関数は resetTenantMonthlyCounters の **前** に呼ばなければならない
 *   (= リセット後だと値が 0 になっており snapshot に意味がない)。
 *
 * @returns insert / update に成功したテナント件数
 */
export async function saveMonthlyUsageSnapshots(now: Date = new Date()): Promise<number> {
  const monthStart = getCurrentMonthStartUtc(now);
  const yearMonth = getPreviousYearMonth(now);

  // リセット対象テナント (= まだリセットされていない、当月分の値を保持中) を取得
  const targets = await prisma.tenant.findMany({
    where: {
      id: { not: MANAGEMENT_TENANT_ID },
      deletedAt: null,
      OR: [{ lastResetAt: null }, { lastResetAt: { lt: monthStart } }],
    },
    select: {
      id: true,
      plan: true,
      currentMonthApiCallCount: true,
      currentMonthApiCostJpy: true,
    },
  });

  if (targets.length === 0) return 0;

  // アクティブユーザ数を groupBy で 1 クエリ取得 (N+1 回避)
  const userCounts = await prisma.user.groupBy({
    by: ['tenantId'],
    where: {
      isActive: true,
      deletedAt: null,
      tenantId: { in: targets.map((t) => t.id) },
    },
    _count: { id: true },
  });
  const userCountByTenant = new Map(userCounts.map((u) => [u.tenantId, u._count.id]));

  let saved = 0;
  for (const tenant of targets) {
    try {
      await prisma.tenantMonthlyUsageHistory.upsert({
        where: {
          tenantId_yearMonth: { tenantId: tenant.id, yearMonth },
        },
        create: {
          tenantId: tenant.id,
          yearMonth,
          apiCallCount: tenant.currentMonthApiCallCount,
          apiCostJpy: tenant.currentMonthApiCostJpy,
          plan: tenant.plan,
          activeUserCount: userCountByTenant.get(tenant.id) ?? 0,
        },
        update: {
          // 同月再実行: 最新値で update (cron が複数回起動された場合の整合性確保)
          apiCallCount: tenant.currentMonthApiCallCount,
          apiCostJpy: tenant.currentMonthApiCostJpy,
          plan: tenant.plan,
          activeUserCount: userCountByTenant.get(tenant.id) ?? 0,
        },
      });
      saved += 1;
    } catch (error) {
      // 1 テナントの失敗で cron 全体を落とさない (他テナントの snapshot 保存は継続)
      await recordError({
        severity: 'error',
        source: 'cron',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        context: { kind: 'tenant_monthly_snapshot', tenantId: tenant.id, yearMonth },
      });
    }
  }

  return saved;
}

/**
 * 月初を跨いだテナントの API 呼び出しカウンタ + 課金額を 0 にリセットする。
 *
 * - 対象: deletedAt IS NULL AND (lastResetAt IS NULL OR lastResetAt < 当月初 UTC)
 * - 結果: currentMonthApiCallCount=0, currentMonthApiCostJpy=0, lastResetAt=当月初
 * - 冪等: 一度適用済みのテナントは再対象外
 */
export async function resetTenantMonthlyCounters(now: Date = new Date()): Promise<number> {
  const monthStart = getCurrentMonthStartUtc(now);
  const result = await prisma.tenant.updateMany({
    where: {
      deletedAt: null,
      OR: [{ lastResetAt: null }, { lastResetAt: { lt: monthStart } }],
    },
    data: {
      currentMonthApiCallCount: 0,
      currentMonthApiCostJpy: 0,
      lastResetAt: monthStart,
    },
  });
  return result.count;
}

/**
 * scheduledPlanChangeAt 到達テナントに scheduledNextPlan を適用する。
 *
 * - 対象: deletedAt IS NULL AND scheduledPlanChangeAt <= now AND scheduledNextPlan IS NOT NULL
 * - 結果: plan=scheduledNextPlan, scheduledPlanChangeAt=NULL, scheduledNextPlan=NULL
 * - scheduledNextPlan が不正値ならエラーログ記録 + skip (該当テナントは scheduled 列を残す)
 */
export async function applyScheduledPlanChanges(
  now: Date = new Date(),
): Promise<{ applied: number; invalidSkipped: number }> {
  const candidates = await prisma.tenant.findMany({
    where: {
      deletedAt: null,
      scheduledPlanChangeAt: { lte: now },
      scheduledNextPlan: { not: null },
    },
    select: { id: true, scheduledNextPlan: true },
  });

  let applied = 0;
  let invalidSkipped = 0;

  for (const tenant of candidates) {
    const nextPlan = tenant.scheduledNextPlan;
    if (!isTenantPlan(nextPlan)) {
      // DB 不整合: 過去のリリースから値が壊れている / 手動 SQL で不正値が入った等
      invalidSkipped += 1;
      await recordError({
        severity: 'error',
        source: 'cron',
        message: `Invalid scheduledNextPlan: ${String(nextPlan)} (tenant=${tenant.id})`,
        context: { kind: 'tenant_plan_apply', tenantId: tenant.id, nextPlan },
      });
      continue;
    }

    try {
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          plan: nextPlan,
          scheduledPlanChangeAt: null,
          scheduledNextPlan: null,
        },
      });
      applied += 1;
    } catch (error) {
      // 1 テナントの失敗で cron 全体を落とさない (他テナントは適用継続)
      await recordError({
        severity: 'error',
        source: 'cron',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        context: { kind: 'tenant_plan_apply', tenantId: tenant.id },
      });
    }
  }

  return { applied, invalidSkipped };
}

/**
 * 月次バッチのエントリポイント。Vercel Cron が叩く API ルートから呼ばれる。
 *
 * 順序: snapshot 保存 → 月初リセット → プラン変更適用
 *
 * P-5b (2026-05-08): スナップショット保存ステップを追加。リセット **前** の値を
 * tenant_monthly_usage_history に保存することで、後から月次の使用量を再現できる
 * (請求書根拠 / 履歴グラフ / CSV エクスポート)。
 */
export async function runTenantMonthlyReset(
  now: Date = new Date(),
): Promise<TenantMonthlyResetResult> {
  // P-5b: リセット直前にスナップショット保存 (順序重要: reset 後だと値が 0 になる)
  const snapshotSavedCount = await saveMonthlyUsageSnapshots(now);
  const resetCount = await resetTenantMonthlyCounters(now);
  const { applied, invalidSkipped } = await applyScheduledPlanChanges(now);
  return {
    resetCount,
    planAppliedCount: applied,
    invalidPlanSkippedCount: invalidSkipped,
    snapshotSavedCount,
  };
}
