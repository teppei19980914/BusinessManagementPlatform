/**
 * API 利用量整合性チェック / 修復サービス (2026-05-14)
 *
 * 役割:
 *   `Tenant.currentMonthApiCallCount` / `currentMonthApiCostJpy` は LLM 呼出時
 *   (`src/lib/llm/metered.ts`) で increment されるリアルタイム counter だが、
 *   トランザクション失敗・cron リセット境界・直接 SQL 改変等で `ApiCallLog` の
 *   SUM とズレ得る。super_admin / テナント管理者ダッシュボード遷移時に
 *   ApiCallLog から SUM/COUNT を取って表示し、5% 以上の drift があれば警告 chip。
 *
 * 設計判断:
 *   - **自動上書きしない**: counter は LLM 呼出ホットパスで race が発生し得るので、
 *     drift を見つけても super_admin が明示的に `repairTenantApiUsage` を呼ぶ。
 *   - **月境界は UTC 月初**: `src/services/tenant-monthly-reset.service.ts` の
 *     月初リセット cron が UTC 0:00 に走るため、これと揃える。
 *   - **idx 活用**: `(tenant_id, created_at desc)` の idx_api_call_logs_tenant
 *     により WHERE tenantId + createdAt >= monthStart は O(log N) で完了。
 *
 * 関連:
 *   - cron: src/services/tenant-monthly-reset.service.ts (月初リセット + snapshot 保存)
 *   - counter increment: src/lib/llm/metered.ts:240-260 (withMeteredLLM 内のトランザクション)
 *   - 計画: docs/plans/2026-05-14_dashboard_realtime_recalc.md
 */

import { prisma } from '@/lib/db';
// 2026-05-14: 閾値定数は Client Component (usage-drift-badge.tsx) からも参照されるため
//   純粋な config に分離し、Client bundle に Prisma (pg) を混入させない設計境界。
import { DRIFT_WARNING_THRESHOLD } from '@/config/api-usage-drift';

// 後方互換: 既存の server 側 import 経路を変えないよう re-export する。
export { DRIFT_WARNING_THRESHOLD };

// ================================================================
// 公開型
// ================================================================

export type ApiUsageReconcileResult = {
  tenantId: string;
  /** Tenant 行の currentMonthApiCallCount (リアルタイム counter) */
  cachedCallCount: number;
  /** Tenant 行の currentMonthApiCostJpy */
  cachedCostJpy: number;
  /** ApiCallLog から再集計した呼出回数 (= 真の値) */
  reconciledCallCount: number;
  /** ApiCallLog から再集計した費用 */
  reconciledCostJpy: number;
  /** cached - reconciled (正なら counter 多過、負なら counter 不足) */
  driftCallCount: number;
  driftCostJpy: number;
  /** |driftCostJpy| / max(reconciledCostJpy, 1) ・ 0.0 - inf */
  driftRatio: number;
  /** 月境界 (UTC 月初) */
  monthStartUtc: Date;
  /** driftRatio >= DRIFT_WARNING_THRESHOLD なら true (= 警告 chip 表示対象) */
  hasDrift: boolean;
};

// DRIFT_WARNING_THRESHOLD は @/config/api-usage-drift から re-export (上記)

// ================================================================
// 公開関数
// ================================================================

/**
 * UTC 月初 (= ApiCallLog SUM の起点) を計算する。
 *
 * tenant-monthly-reset cron が UTC 0:00 に Tenant counter をリセットするため、
 * これと揃える。テナント TZ には依存しない (DB 値の整合性検証のため UTC で固定)。
 */
export function getCurrentMonthStartUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * 単一テナントの API 利用量整合性チェック。
 *
 * @param tenantId 対象テナント
 * @param now 検証時刻 (デフォルト現在)
 * @returns Tenant counter と ApiCallLog SUM の比較結果。テナント不在なら null
 */
export async function reconcileTenantApiUsage(
  tenantId: string,
  now: Date = new Date(),
): Promise<ApiUsageReconcileResult | null> {
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      id: true,
      currentMonthApiCallCount: true,
      currentMonthApiCostJpy: true,
    },
  });
  if (!tenant) return null;

  const monthStart = getCurrentMonthStartUtc(now);
  const aggregate = await prisma.apiCallLog.aggregate({
    where: { tenantId, createdAt: { gte: monthStart } },
    _count: { _all: true },
    _sum: { costJpy: true },
  });

  const reconciledCallCount = aggregate._count._all;
  const reconciledCostJpy = aggregate._sum.costJpy ?? 0;
  const driftCallCount = tenant.currentMonthApiCallCount - reconciledCallCount;
  const driftCostJpy = tenant.currentMonthApiCostJpy - reconciledCostJpy;
  const driftRatio =
    Math.abs(driftCostJpy) / Math.max(reconciledCostJpy, 1);

  return {
    tenantId: tenant.id,
    cachedCallCount: tenant.currentMonthApiCallCount,
    cachedCostJpy: tenant.currentMonthApiCostJpy,
    reconciledCallCount,
    reconciledCostJpy,
    driftCallCount,
    driftCostJpy,
    driftRatio,
    monthStartUtc: monthStart,
    hasDrift: driftRatio >= DRIFT_WARNING_THRESHOLD,
  };
}

/**
 * 全テナント (削除済除外) の API 利用量整合性チェック。
 *
 * `Promise.allSettled` で並列実行、個別失敗は除外して成功分のみ返す。
 * super_admin ダッシュボード遷移時に呼ぶ。
 */
export async function reconcileAllTenantsApiUsage(
  now: Date = new Date(),
): Promise<ApiUsageReconcileResult[]> {
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });

  const settled = await Promise.allSettled(
    tenants.map((t) => reconcileTenantApiUsage(t.id, now)),
  );

  const results: ApiUsageReconcileResult[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value) {
      results.push(s.value);
    }
  }
  return results;
}

/**
 * テナントの API counter を ApiCallLog SUM で上書きする (super_admin の明示操作専用)。
 *
 * 注意:
 *   - tenant-monthly-reset cron 実行中 (UTC 0:00 ±5min) に呼ぶと race が起きる
 *     可能性がある。UI 側で disabled 制御することを推奨。
 *   - 月境界を跨ぐ ApiCallLog は除外される (UTC 月初以降のみ SUM)。
 *
 * @param tenantId 対象テナント
 * @param now 検証時刻
 * @returns 修復後の値 (テナント不在なら null)
 */
export async function repairTenantApiUsage(
  tenantId: string,
  now: Date = new Date(),
): Promise<ApiUsageReconcileResult | null> {
  const before = await reconcileTenantApiUsage(tenantId, now);
  if (!before) return null;

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      currentMonthApiCallCount: before.reconciledCallCount,
      currentMonthApiCostJpy: before.reconciledCostJpy,
    },
  });

  return {
    ...before,
    cachedCallCount: before.reconciledCallCount,
    cachedCostJpy: before.reconciledCostJpy,
    driftCallCount: 0,
    driftCostJpy: 0,
    driftRatio: 0,
    hasDrift: false,
  };
}
