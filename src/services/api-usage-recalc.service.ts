/**
 * API 利用量整合性チェック / 修復サービス (2026-05-14, PR-V8 2026-05-19 改修)
 *
 * 役割:
 *   `Tenant.currentMonthApiCallCount` / `currentMonthApiCostJpy` は LLM 呼出時
 *   (`src/lib/llm/metered.ts`) で increment されるリアルタイム counter だが、
 *   トランザクション失敗・cron リセット境界・直接 SQL 改変等で `ApiCallLog` の
 *   SUM とズレ得る。super_admin / テナント管理者ダッシュボード遷移時に
 *   ApiCallLog から SUM/COUNT を取って表示し、閾値以上の drift があれば警告 chip。
 *
 * 設計判断 (PR-V8 改訂版):
 *   - **driftRatio は call-count と cost の max を取る**: 旧設計は cost のみで判定していたが、
 *     Beginner プラン (cost=0) では呼出回数がいくらズレても driftRatio=0/max(0,1)=0 となり
 *     永久に沈黙する設計バグがあった (= 本番事故の真因)。call-count 比率を併用し、
 *     どちらかの 1 軸で閾値超なら hasDrift=true とする。
 *   - **月境界はテナント TZ ベース**: 月初リセット cron (tenant-monthly-reset) が
 *     テナント TZ 月初基準で動くため (PR-4 / 2026-05-15)、再集計側も同じ基準に
 *     揃える。旧設計の UTC 月初固定だと、テナント TZ と UTC の 9〜16h ズレで
 *     常に drift が誤検知される問題があった (= 本番事故の二次原因)。
 *   - **自動上書きしない**: counter は LLM 呼出ホットパスで race が発生し得るので、
 *     drift を見つけても super_admin が明示的に `repairTenantApiUsage` を呼ぶ。
 *   - **idx 活用**: `(tenant_id, created_at desc)` の idx_api_call_logs_tenant
 *     により WHERE tenantId + createdAt >= monthStart は O(log N) で完了。
 *
 * 関連:
 *   - cron: src/services/tenant-monthly-reset.service.ts (月初リセット + snapshot 保存)
 *   - counter increment: src/lib/llm/metered.ts:240-260 (withMeteredLLM 内のトランザクション)
 *   - 計画: docs/plans/2026-05-14_dashboard_realtime_recalc.md
 *   - 改訂計画: docs/plans/2026-05-19_diagnostics_dashboard.md
 */

import { prisma } from '@/lib/db';
// 2026-05-14: 閾値定数は Client Component (usage-drift-badge.tsx) からも参照されるため
//   純粋な config に分離し、Client bundle に Prisma (pg) を混入させない設計境界。
import { DRIFT_WARNING_THRESHOLD } from '@/config/api-usage-drift';
// PR-V8 (2026-05-19): テナント TZ 月初をベースにする (月初リセット cron と境界統一)
import { getTenantMonthStart } from '@/lib/tenant-time';
import { DEFAULT_TIMEZONE } from '@/config/i18n';

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
  /**
   * 呼出回数ベースの drift 比率: |driftCallCount| / max(reconciledCallCount, 1)
   * PR-V8 で追加。Beginner プラン (cost=0) で call drift を検知するための主要指標。
   */
  driftCallRatio: number;
  /**
   * 費用ベースの drift 比率: |driftCostJpy| / max(reconciledCostJpy, 1)
   * PR-V8 以前の唯一の判定軸だったが、cost=0 のプランで常に 0 になる問題があった。
   */
  driftCostRatio: number;
  /**
   * 総合 drift 比率: max(driftCallRatio, driftCostRatio)
   * 旧 `driftRatio` フィールド名を保持 (互換性のため)。
   */
  driftRatio: number;
  /** 月境界 (テナント TZ 月初を UTC Date で表現、PR-V8 で UTC→TZ に変更) */
  monthStart: Date;
  /**
   * @deprecated PR-V8 で `monthStart` に改名 (テナント TZ ベース)。
   *   旧 API 互換のため当面残置する。新規参照は `monthStart` を使うこと。
   */
  monthStartUtc: Date;
  /** driftRatio >= DRIFT_WARNING_THRESHOLD なら true (= 警告 chip 表示対象) */
  hasDrift: boolean;
};

// DRIFT_WARNING_THRESHOLD は @/config/api-usage-drift から re-export (上記)

// ================================================================
// 公開関数
// ================================================================

/**
 * UTC 月初を計算する (旧仕様、後方互換のため残置)。
 *
 * @deprecated PR-V8 (2026-05-19) で `getTenantMonthStart(now, timezone)` に
 *   置換済。新規呼び出しでは使わない。`reconcileTenantApiUsage` 等は内部で
 *   テナント TZ 月初を使うようになった。
 */
export function getCurrentMonthStartUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * 単一テナントの API 利用量整合性チェック。
 *
 * 月境界はテナント TZ 月初 (PR-V8 改訂)。`Tenant.timezone` を取得して
 * `getTenantMonthStart(now, tenant.timezone)` で算出する。
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
      timezone: true,
      currentMonthApiCallCount: true,
      currentMonthApiCostJpy: true,
    },
  });
  if (!tenant) return null;

  // PR-V8: テナント TZ 月初を起点 (月初リセット cron と境界統一)
  const timezone = tenant.timezone ?? DEFAULT_TIMEZONE;
  const monthStart = getTenantMonthStart(now, timezone);
  const aggregate = await prisma.apiCallLog.aggregate({
    where: { tenantId, createdAt: { gte: monthStart } },
    _count: { _all: true },
    _sum: { costJpy: true },
  });

  const reconciledCallCount = aggregate._count._all;
  const reconciledCostJpy = aggregate._sum.costJpy ?? 0;
  const driftCallCount = tenant.currentMonthApiCallCount - reconciledCallCount;
  const driftCostJpy = tenant.currentMonthApiCostJpy - reconciledCostJpy;
  // PR-V8: call-count / cost の 2 軸で drift を判定 (max を取る)。
  //   旧設計は cost のみで Beginner (cost=0) では永久に 0 になっていた。
  const driftCallRatio =
    Math.abs(driftCallCount) / Math.max(reconciledCallCount, 1);
  const driftCostRatio =
    Math.abs(driftCostJpy) / Math.max(reconciledCostJpy, 1);
  const driftRatio = Math.max(driftCallRatio, driftCostRatio);

  return {
    tenantId: tenant.id,
    cachedCallCount: tenant.currentMonthApiCallCount,
    cachedCostJpy: tenant.currentMonthApiCostJpy,
    reconciledCallCount,
    reconciledCostJpy,
    driftCallCount,
    driftCostJpy,
    driftCallRatio,
    driftCostRatio,
    driftRatio,
    monthStart,
    monthStartUtc: monthStart, // @deprecated
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
 * **PR-V8 (2026-05-19) 改訂**:
 *   - audit_log を記録するように変更 (before/after 値を保存)
 *   - 月境界はテナント TZ ベース (`reconcileTenantApiUsage` 経由)
 *
 * 注意:
 *   - tenant-monthly-reset cron 実行中 (テナント TZ 月初 ±5min) に呼ぶと race が
 *     起きる可能性がある。UI 側で disabled 制御することを推奨。
 *   - 月境界を跨ぐ ApiCallLog は除外される (テナント TZ 月初以降のみ SUM)。
 *
 * @param tenantId 対象テナント
 * @param actorUserId 操作者 (audit_log 用)。省略時は SYSTEM_USER_ID 扱い。
 * @param now 検証時刻
 * @returns 修復後の値 (テナント不在なら null)
 */
export async function repairTenantApiUsage(
  tenantId: string,
  actorUserId?: string,
  now: Date = new Date(),
): Promise<ApiUsageReconcileResult | null> {
  const before = await reconcileTenantApiUsage(tenantId, now);
  if (!before) return null;

  // PR-V8: counter 上書きと audit_log 記録を 1 transaction で実行 (= 整合性確保)。
  //   actorUserId が無い場合 (= cron / system 経由) は audit_log を作らない設計とする
  //   (audit_logs.userId は NOT NULL のため)。
  if (actorUserId) {
    await prisma.$transaction([
      prisma.tenant.update({
        where: { id: tenantId },
        data: {
          currentMonthApiCallCount: before.reconciledCallCount,
          currentMonthApiCostJpy: before.reconciledCostJpy,
        },
      }),
      prisma.auditLog.create({
        data: {
          tenantId,
          userId: actorUserId,
          action: 'UPDATE',
          entityType: 'tenant',
          entityId: tenantId,
          beforeValue: {
            currentMonthApiCallCount: before.cachedCallCount,
            currentMonthApiCostJpy: before.cachedCostJpy,
          },
          afterValue: {
            operation: 'repair-api-usage',
            currentMonthApiCallCount: before.reconciledCallCount,
            currentMonthApiCostJpy: before.reconciledCostJpy,
            driftCallCount: before.driftCallCount,
            driftCostJpy: before.driftCostJpy,
            driftRatio: before.driftRatio,
            monthStart: before.monthStart.toISOString(),
          },
        },
      }),
    ]);
  } else {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        currentMonthApiCallCount: before.reconciledCallCount,
        currentMonthApiCostJpy: before.reconciledCostJpy,
      },
    });
  }

  return {
    ...before,
    cachedCallCount: before.reconciledCallCount,
    cachedCostJpy: before.reconciledCostJpy,
    driftCallCount: 0,
    driftCostJpy: 0,
    driftCallRatio: 0,
    driftCostRatio: 0,
    driftRatio: 0,
    hasDrift: false,
  };
}
