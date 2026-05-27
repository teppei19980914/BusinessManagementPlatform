/**
 * 月次履歴の ApiCallLog ベース再生成サービス (PR-V8 / 2026-05-19)
 *
 * ★請求重要★
 *   既存の `tenant_monthly_usage_history` (snapshot) は `Tenant.currentMonthApiCallCount`
 *   (counter) のリセット直前値を保存していたため、counter が破損していた月の履歴は
 *   破損したまま保存される脆弱性があった (= 本件 Default テナントの drift 7/8 で発覚)。
 *
 *   本 service は ApiCallLog (= 監査用のイミュータブル記録) から真値を再集計して
 *   履歴を上書きする。「過去月の請求書根拠を真値で作り直す」ための運用 API。
 *
 * 動作:
 *   1. 対象 yearMonth (= 'YYYY-MM') の **テナント TZ** での期間範囲を計算
 *   2. その期間内の ApiCallLog を tenantId で絞って SUM (COUNT + costJpy)
 *   3. tenant_monthly_usage_history を upsert (snapshot 上書き)
 *   4. audit_log に operation='regenerate-monthly-history' を 1 transaction で記録
 *
 * 注意:
 *   - 月境界はテナント TZ ベース。Asia/Tokyo (UTC+9) なら 2026-05 = JST 5/1 00:00 〜 6/1 00:00
 *     = UTC 4/30 15:00 〜 5/31 15:00 の範囲で集計する。
 *   - storage_bytes_used / active_user_count は ApiCallLog から計算できない (= 現在値のみ)
 *     ため、既存 snapshot 値を保持する設計。ない場合は 0 / 現在値で埋める。
 *   - 当月の再生成も可能だが、まだ ApiCallLog が増える可能性があるため運用上は前月以前推奨。
 *
 * 関連:
 *   - 既存 snapshot: src/services/tenant-monthly-reset.service.ts:saveMonthlyUsageSnapshots
 *   - UI: src/app/(dashboard)/admin/super/tenants/[id]/diagnostics/page.tsx で「再生成」ボタン
 */

import { prisma } from '@/lib/db';
import { getTenantMonthStart, getTenantNextMonthStart } from '@/lib/tenant-time';
import { DEFAULT_TIMEZONE } from '@/config/i18n';
// ADR-0019 (2026-05-24): 月次履歴再生成も課金対象 featureUnit のみで集計。
import {
  BILLABLE_FEATURE_UNITS,
  EMBEDDING_BILLABLE_FEATURE_UNITS,
} from '@/config/billing-feature-units';

// chore/storage-addon-backend-removal (2026-05-26):
//   ADR-0020 (DB 容量従量課金) + ADR-0021 (添付ファイル従量課金) で完全従量課金化済のため、
//   旧 storage_addon 4 段階プラン (Standard/Plus/Pro/Enterprise) は撤去。
//   storageAddonPlan / storageAddonJpy のスナップショット保存は中止。

// ================================================================
// 公開型
// ================================================================

export type RegenerateResult = {
  tenantId: string;
  yearMonth: string;
  /** ApiCallLog から再計算した呼出回数 */
  reconciledCallCount: number;
  /** ApiCallLog から再計算した費用 */
  reconciledCostJpy: number;
  /** 既存 snapshot 値 (上書き前)。snapshot 不在なら null */
  previousSnapshot: {
    apiCallCount: number;
    apiCostJpy: number;
  } | null;
  /** 集計範囲の開始 (テナント TZ 月初 → UTC Date) */
  rangeStart: Date;
  /** 集計範囲の終了 (テナント TZ 翌月初 → UTC Date) */
  rangeEnd: Date;
};

// ================================================================
// 公開関数
// ================================================================

/**
 * 指定テナント × 指定 yearMonth の月次履歴を ApiCallLog から再生成する。
 *
 * @param tenantId 対象テナント
 * @param yearMonth 'YYYY-MM' (例: '2026-04')
 * @param actorUserId 操作者 (audit_log 用、必須)
 * @returns 再生成結果。テナント不在なら null
 */
export async function regenerateMonthlyHistoryFromApiCallLog(
  tenantId: string,
  yearMonth: string,
  actorUserId: string,
): Promise<RegenerateResult | null> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) {
    throw new Error(`不正な yearMonth: ${yearMonth} (期待形式 YYYY-MM)`);
  }

  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId },
    select: {
      id: true,
      plan: true,
      timezone: true,
      storageBytesUsed: true,
    },
  });
  if (!tenant) return null;

  const timezone = tenant.timezone ?? DEFAULT_TIMEZONE;
  // 対象月の 1 日 00:00 (テナント TZ) を「YYYY-MM-01 00:00 ローカル」として表現するため、
  //   `new Date('YYYY-MM-15T00:00:00Z')` を月中の代表値として getTenantMonthStart に渡す。
  //   この結果は対象月のテナント TZ 月初 UTC Date になる。
  const midOfMonthUtc = new Date(`${yearMonth}-15T00:00:00Z`);
  const rangeStart = getTenantMonthStart(midOfMonthUtc, timezone);
  const rangeEnd = getTenantNextMonthStart(midOfMonthUtc, timezone);

  // ADR-0022 (2026-06-01): Embedding 内訳も saveMonthlyUsageSnapshots と同条件で再集計し
  //   tenant_monthly_usage_history.embeddingCallCount / embeddingCostJpy に保存する。
  //   feedback_3layer_sync_filter: 月初 cron / super_admin 手動再生成 / 解約時 snapshot の
  //   3 経路で内訳列を同期更新する必要がある。
  const [aggregate, embeddingAggregate, activeUserCount, previousSnapshot] = await Promise.all([
    prisma.apiCallLog.aggregate({
      where: {
        tenantId,
        createdAt: { gte: rangeStart, lt: rangeEnd },
        // ADR-0019 (2026-05-24): billable のみで集計 (= snapshot 保存と同条件、ADR-0022 で Embedding 含む)
        featureUnit: { in: [...BILLABLE_FEATURE_UNITS] },
      },
      _count: { _all: true },
      _sum: { costJpy: true },
    }),
    // ADR-0022 (2026-06-01): Embedding 内訳の独立 SUM (= tenant-monthly-reset.service と同パターン)
    prisma.apiCallLog.aggregate({
      where: {
        tenantId,
        createdAt: { gte: rangeStart, lt: rangeEnd },
        featureUnit: { in: [...EMBEDDING_BILLABLE_FEATURE_UNITS] },
      },
      _count: { _all: true },
      _sum: { costJpy: true },
    }),
    prisma.user.count({
      where: { tenantId, isActive: true, deletedAt: null },
    }),
    prisma.tenantMonthlyUsageHistory.findUnique({
      where: { tenantId_yearMonth: { tenantId, yearMonth } },
      // ADR-0022 (2026-06-01): audit_log の before に embedding 内訳も含めるため select 拡張
      select: {
        apiCallCount: true,
        apiCostJpy: true,
        embeddingCallCount: true,
        embeddingCostJpy: true,
      },
    }),
  ]);

  const reconciledCallCount = aggregate._count._all;
  const reconciledCostJpy = aggregate._sum.costJpy ?? 0;
  // ADR-0022 (2026-06-01): Embedding 内訳 (apiCallCount の subset、Beginner は cost=0 でも件数記録)
  const embeddingCallCount = embeddingAggregate._count._all;
  const embeddingCostJpy = embeddingAggregate._sum.costJpy ?? 0;

  // chore/storage-addon-backend-removal (2026-05-26): 旧 storage_addon 4 段階プランは廃止のため
  //   月額固定費の加算は無し。totalJpy = API 利用料 (storage 従量課金は別 cron で計算)。
  //   ADR-0022 (2026-06-01): BILLABLE_FEATURE_UNITS が Embedding も含むため、Embedding 課金分も
  //   自動的に reconciledCostJpy / totalJpy に乗る (= 二重カウントなし)。
  const totalJpy = reconciledCostJpy;

  // upsert + audit を 1 transaction で
  await prisma.$transaction([
    prisma.tenantMonthlyUsageHistory.upsert({
      where: { tenantId_yearMonth: { tenantId, yearMonth } },
      create: {
        tenantId,
        yearMonth,
        apiCallCount: reconciledCallCount,
        apiCostJpy: reconciledCostJpy,
        plan: tenant.plan,
        activeUserCount,
        storageBytesUsed: tenant.storageBytesUsed,
        // ADR-0022 (2026-06-01): Embedding 内訳列
        embeddingCallCount,
        embeddingCostJpy,
        totalJpy,
      },
      update: {
        apiCallCount: reconciledCallCount,
        apiCostJpy: reconciledCostJpy,
        plan: tenant.plan,
        activeUserCount,
        storageBytesUsed: tenant.storageBytesUsed,
        // ADR-0022 (2026-06-01): Embedding 内訳列
        embeddingCallCount,
        embeddingCostJpy,
        totalJpy,
      },
    }),
    prisma.auditLog.create({
      data: {
        tenantId,
        userId: actorUserId,
        action: 'UPDATE',
        entityType: 'tenant',
        entityId: tenantId,
        beforeValue: previousSnapshot
          ? {
              apiCallCount: previousSnapshot.apiCallCount,
              apiCostJpy: previousSnapshot.apiCostJpy,
              // ADR-0022: Embedding 内訳の before 値 (ADR-0022 適用前の過去月は null)
              embeddingCallCount: previousSnapshot.embeddingCallCount,
              embeddingCostJpy: previousSnapshot.embeddingCostJpy,
            }
          : undefined,
        afterValue: {
          operation: 'regenerate-monthly-history',
          yearMonth,
          reconciledCallCount,
          reconciledCostJpy,
          // ADR-0022: Embedding 内訳の after 値
          embeddingCallCount,
          embeddingCostJpy,
          rangeStart: rangeStart.toISOString(),
          rangeEnd: rangeEnd.toISOString(),
        },
      },
    }),
  ]);

  return {
    tenantId,
    yearMonth,
    reconciledCallCount,
    reconciledCostJpy,
    previousSnapshot,
    rangeStart,
    rangeEnd,
  };
}
