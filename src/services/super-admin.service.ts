/**
 * super_admin (プラットフォーム運営者) 専用サービス (PR-X2 / 2026-05-07)
 *
 * 役割:
 *   全テナント横断の監視・集計を行う。super_admin role でのみ使用可能。
 *   呼出側は API route / page で `isSuperAdmin(user)` で認可ガードしたうえで
 *   本サービスを呼ぶ前提 (本サービス内では呼出者の role 検証は行わない =
 *   呼出側責任。テストしやすさと依存最小化のための設計)。
 *
 * 設計原則:
 *   - 管理テナント (Knowledge Relay Platform) は集計から除外する
 *     (運営内部のテナントを顧客集計に混ぜない、§ROLE_REFACTORING_PLAN §4 リスク対策)
 *   - 論理削除されたテナントも除外
 *
 * 関連:
 *   - 計画: docs/roadmap/ROLE_REFACTORING_PLAN.md §3.2
 *   - 認可ヘルパ: src/lib/permissions/role.ts (isSuperAdmin)
 */

import { prisma } from '@/lib/db';
import { MANAGEMENT_TENANT_ID } from '@/lib/tenant';

/**
 * 全テナント一覧 (super_admin ダッシュボード用)。
 *
 * 含めるテナント: 顧客テナント (= MANAGEMENT_TENANT_ID 以外、deletedAt=null)
 * 含めないもの: 管理テナント (運営内部) / 論理削除済み
 *
 * 各テナントには使用量集計とアクティブユーザ数を含める。
 */
export type TenantSummaryRow = {
  id: string;
  tenantSeq: number | null;
  slug: string;
  name: string;
  plan: string;
  currentMonthApiCallCount: number;
  currentMonthApiCostJpy: number;
  monthlyBudgetCapJpy: number | null;
  activeUserCount: number;
  createdAt: Date;
};

export async function listAllTenants(): Promise<TenantSummaryRow[]> {
  const tenants = await prisma.tenant.findMany({
    where: {
      id: { not: MANAGEMENT_TENANT_ID },
      deletedAt: null,
    },
    orderBy: { tenantSeq: 'asc' },
    select: {
      id: true,
      tenantSeq: true,
      slug: true,
      name: true,
      plan: true,
      currentMonthApiCallCount: true,
      currentMonthApiCostJpy: true,
      monthlyBudgetCapJpy: true,
      createdAt: true,
    },
  });

  // 各テナントのアクティブユーザ数を groupBy で 1 クエリ取得 (N+1 回避)
  const userCounts = await prisma.user.groupBy({
    by: ['tenantId'],
    where: {
      isActive: true,
      deletedAt: null,
      tenantId: { in: tenants.map((t) => t.id) },
    },
    _count: { id: true },
  });
  const userCountByTenant = new Map(userCounts.map((u) => [u.tenantId, u._count.id]));

  return tenants.map((t) => ({
    id: t.id,
    tenantSeq: t.tenantSeq,
    slug: t.slug,
    name: t.name,
    plan: t.plan,
    currentMonthApiCallCount: t.currentMonthApiCallCount,
    currentMonthApiCostJpy: t.currentMonthApiCostJpy,
    monthlyBudgetCapJpy: t.monthlyBudgetCapJpy,
    activeUserCount: userCountByTenant.get(t.id) ?? 0,
    createdAt: t.createdAt,
  }));
}

/**
 * テナント詳細 (super_admin ダッシュボードのテナント詳細画面用)。
 * 管理テナントへのアクセスは禁止 (= 顧客テナント以外は監視対象外)。
 */
export type TenantDetail = TenantSummaryRow & {
  beginnerMonthlyCallLimit: number;
  beginnerMaxSeats: number;
  scheduledPlanChangeAt: Date | null;
  scheduledNextPlan: string | null;
  entityCounts: {
    projects: number;
    knowledges: number;
    risksIssues: number;
    retrospectives: number;
    memos: number;
  };
};

export async function getTenantDetail(tenantId: string): Promise<TenantDetail | null> {
  if (tenantId === MANAGEMENT_TENANT_ID) {
    return null; // 管理テナントは詳細画面の対象外
  }

  const t = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
  });
  if (!t) return null;

  const [activeUserCount, projects, knowledges, risksIssues, retrospectives, memos] = await Promise.all([
    prisma.user.count({ where: { tenantId, isActive: true, deletedAt: null } }),
    prisma.project.count({ where: { tenantId, deletedAt: null } }),
    prisma.knowledge.count({ where: { tenantId, deletedAt: null } }),
    prisma.riskIssue.count({ where: { tenantId, deletedAt: null } }),
    prisma.retrospective.count({ where: { tenantId, deletedAt: null } }),
    prisma.memo.count({ where: { tenantId, deletedAt: null } }),
  ]);

  return {
    id: t.id,
    tenantSeq: t.tenantSeq,
    slug: t.slug,
    name: t.name,
    plan: t.plan,
    currentMonthApiCallCount: t.currentMonthApiCallCount,
    currentMonthApiCostJpy: t.currentMonthApiCostJpy,
    monthlyBudgetCapJpy: t.monthlyBudgetCapJpy,
    activeUserCount,
    createdAt: t.createdAt,
    beginnerMonthlyCallLimit: t.beginnerMonthlyCallLimit,
    beginnerMaxSeats: t.beginnerMaxSeats,
    scheduledPlanChangeAt: t.scheduledPlanChangeAt,
    scheduledNextPlan: t.scheduledNextPlan,
    entityCounts: { projects, knowledges, risksIssues, retrospectives, memos },
  };
}

/**
 * 全テナント横断の使用量サマリ (super_admin ダッシュボードのサマリ画面用)。
 * 管理テナントは除外して集計。
 */
export type CrossTenantUsageSummary = {
  tenantCount: number;
  totalActiveUsers: number;
  totalCurrentMonthApiCalls: number;
  totalCurrentMonthApiCostJpy: number;
  planDistribution: { plan: string; count: number }[];
};

export async function getCrossTenantUsageSummary(): Promise<CrossTenantUsageSummary> {
  const tenantWhere = {
    id: { not: MANAGEMENT_TENANT_ID },
    deletedAt: null,
  };

  const [tenantCount, agg, planGroups, activeUsersAgg] = await Promise.all([
    prisma.tenant.count({ where: tenantWhere }),
    prisma.tenant.aggregate({
      where: tenantWhere,
      _sum: { currentMonthApiCallCount: true, currentMonthApiCostJpy: true },
    }),
    prisma.tenant.groupBy({
      by: ['plan'],
      where: tenantWhere,
      _count: { id: true },
    }),
    prisma.user.count({
      where: {
        isActive: true,
        deletedAt: null,
        tenantId: { not: MANAGEMENT_TENANT_ID },
      },
    }),
  ]);

  return {
    tenantCount,
    totalActiveUsers: activeUsersAgg,
    totalCurrentMonthApiCalls: agg._sum.currentMonthApiCallCount ?? 0,
    totalCurrentMonthApiCostJpy: agg._sum.currentMonthApiCostJpy ?? 0,
    planDistribution: planGroups.map((p) => ({ plan: p.plan, count: p._count.id })),
  };
}
