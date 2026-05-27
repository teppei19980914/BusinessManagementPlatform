/**
 * 個別テナント診断サービス (PR-V8 / 2026-05-19)
 *
 * 役割:
 *   `/admin/super/tenants/[id]/diagnostics` ページに表示する詳細データを集約する。
 *   システム全体の異常 (diagnostics.service.ts) に対し、こちらは「特定テナントで
 *   今何が起きているか」を時系列で可視化する。
 *
 *   表示内容:
 *     1. テナント基本情報 (timezone / plan / createdAt 等)
 *     2. counter vs ApiCallLog SUM の整合性 (reconcileTenantApiUsage)
 *     3. 直近 30 日の ApiCallLog 時系列 (日別件数 + cost)
 *     4. counter / plan 書き換え系 audit_log の抽出
 *        - operation='repair-api-usage'
 *        - operation='recalculate-self'
 *        - operation='recalculate'
 *        - operation='monthly-reset' (PR-V8 で reset audit 追加後)
 *     5. 月次履歴 (tenant_monthly_usage_history) と ApiCallLog SUM の比較
 *
 * 設計判断:
 *   - **read-only**: 修復ボタンは別 component (RepairDriftButton) で実装
 *   - **直近 30 日に絞る**: ApiCallLog が大量にあるテナントでも軽量に動くよう
 *   - **audit_log は LIKE 検索**: after_value JSON 内の operation を素朴に文字列 LIKE で抽出
 *     (= JSONB index 未整備のため。50 件 limit で軽量)
 */

import { prisma } from '@/lib/db';
import {
  reconcileTenantApiUsage,
  type ApiUsageReconcileResult,
} from './api-usage-recalc.service';

// ================================================================
// 公開型
// ================================================================

export type TenantBasicInfo = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  timezone: string;
  createdAt: Date;
  deletedAt: Date | null;
  currentMonthApiCallCount: number;
  currentMonthApiCostJpy: number;
  /** ADR-0022 (2026-06-01): Embedding 系の当月呼出回数 counter (= 診断画面で Embedding 利用量を表示) */
  currentMonthEmbeddingCallCount: number;
  /** ADR-0022 (2026-06-01): Embedding 系の当月課金額 counter */
  currentMonthEmbeddingCostJpy: number;
  lastResetAt: Date | null;
  updatedAt: Date;
};

export type DailyApiCallSummary = {
  /** YYYY-MM-DD (UTC ベース、ApiCallLog.createdAt の day) */
  date: string;
  count: number;
  costJpy: number;
};

export type CounterWriteAuditLog = {
  id: string;
  createdAt: Date;
  action: string;
  userId: string;
  /** after_value (JSON)。operation / counter 値等を含む。 */
  afterValue: Record<string, unknown> | null;
  beforeValue: Record<string, unknown> | null;
};

export type MonthlyHistoryRow = {
  yearMonth: string;
  apiCallCount: number;
  apiCostJpy: number;
  plan: string;
};

export type TenantDiagnosticsResult = {
  basic: TenantBasicInfo;
  reconcile: ApiUsageReconcileResult | null;
  /** 直近 30 日の日別 ApiCallLog 集計 */
  dailyApiCalls: DailyApiCallSummary[];
  /** counter / plan 書き換え系 audit_log (直近 30 日、最大 50 件) */
  counterWriteAudits: CounterWriteAuditLog[];
  /** 月次履歴 (= tenant_monthly_usage_history、過去 6 ヶ月) */
  monthlyHistory: MonthlyHistoryRow[];
};

// ================================================================
// 公開関数
// ================================================================

export async function getTenantDiagnostics(
  tenantId: string,
  now: Date = new Date(),
): Promise<TenantDiagnosticsResult | null> {
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId },
    select: {
      id: true,
      name: true,
      slug: true,
      plan: true,
      timezone: true,
      createdAt: true,
      deletedAt: true,
      currentMonthApiCallCount: true,
      currentMonthApiCostJpy: true,
      // ADR-0022 (2026-06-01): Embedding counter も診断対象
      currentMonthEmbeddingCallCount: true,
      currentMonthEmbeddingCostJpy: true,
      lastResetAt: true,
      updatedAt: true,
    },
  });
  if (!tenant) return null;

  const basic: TenantBasicInfo = tenant;

  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [reconcile, apiCalls, audits, history] = await Promise.all([
    reconcileTenantApiUsage(tenantId, now),
    prisma.apiCallLog.findMany({
      where: {
        tenantId,
        createdAt: { gte: thirtyDaysAgo },
      },
      select: {
        createdAt: true,
        costJpy: true,
      },
    }),
    prisma.auditLog.findMany({
      where: {
        tenantId,
        entityType: 'tenant',
        entityId: tenantId,
        createdAt: { gte: thirtyDaysAgo },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        createdAt: true,
        action: true,
        userId: true,
        afterValue: true,
        beforeValue: true,
      },
    }),
    prisma.tenantMonthlyUsageHistory.findMany({
      where: { tenantId },
      orderBy: { yearMonth: 'desc' },
      take: 6,
      select: {
        yearMonth: true,
        apiCallCount: true,
        apiCostJpy: true,
        plan: true,
      },
    }),
  ]);

  // 日別集計: ApiCallLog を YYYY-MM-DD で groupBy
  const dailyMap = new Map<string, { count: number; costJpy: number }>();
  for (const log of apiCalls) {
    const date = log.createdAt.toISOString().slice(0, 10);
    const existing = dailyMap.get(date) ?? { count: 0, costJpy: 0 };
    existing.count += 1;
    existing.costJpy += log.costJpy;
    dailyMap.set(date, existing);
  }
  const dailyApiCalls = Array.from(dailyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, count: v.count, costJpy: v.costJpy }));

  // audit_log: counter / plan 書き換え系のみ抽出
  //   afterValue.operation が repair-api-usage / recalculate-self / recalculate / monthly-reset
  //   いずれかを含むものに絞る
  const counterWriteAudits: CounterWriteAuditLog[] = audits
    .filter((a) => {
      const op = (a.afterValue as Record<string, unknown> | null)?.['operation'];
      return (
        typeof op === 'string'
        && (op === 'repair-api-usage'
          || op === 'recalculate-self'
          || op === 'recalculate'
          || op === 'monthly-reset')
      );
    })
    .map((a) => ({
      id: a.id,
      createdAt: a.createdAt,
      action: a.action,
      userId: a.userId,
      afterValue: (a.afterValue as Record<string, unknown> | null) ?? null,
      beforeValue: (a.beforeValue as Record<string, unknown> | null) ?? null,
    }));

  return {
    basic,
    reconcile,
    dailyApiCalls,
    counterWriteAudits,
    monthlyHistory: history,
  };
}
