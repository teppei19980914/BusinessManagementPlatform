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
  // P-G (2026-05-08): 請求先情報 (CSV エクスポート + super_admin 一覧表示用)
  billingCompanyName: string | null;
  billingContactName: string | null;
  billingContactEmail: string | null;
  billingAddress: string | null;
  billingPhoneNumber: string | null;
  paymentMethod: string;
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
      // P-G (2026-05-08): 請求先情報
      billingCompanyName: true,
      billingContactName: true,
      billingContactEmail: true,
      billingAddress: true,
      billingPhoneNumber: true,
      paymentMethod: true,
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
    // P-G (2026-05-08): 請求先情報
    billingCompanyName: t.billingCompanyName,
    billingContactName: t.billingContactName,
    billingContactEmail: t.billingContactEmail,
    billingAddress: t.billingAddress,
    billingPhoneNumber: t.billingPhoneNumber,
    paymentMethod: t.paymentMethod,
  }));
}

/**
 * テナント詳細 (super_admin ダッシュボードのテナント詳細画面用)。
 * 管理テナントへのアクセスは禁止 (= 顧客テナント以外は監視対象外)。
 *
 * P-6 (2026-05-08): 休眠判定用に最終ログイン日時 + 休眠日数を追加。
 *   日数計算はサービス側で済ませて純関数化 (画面での Date.now() 呼出を避けるため)。
 * P-G (2026-05-08): 請求先情報を含める (super_admin が請求業務で参照)。
 */
export type TenantDetail = TenantSummaryRow & {
  beginnerMonthlyCallLimit: number;
  beginnerMaxSeats: number;
  scheduledPlanChangeAt: Date | null;
  scheduledNextPlan: string | null;
  /** P-6: テナント内 **任意** ユーザの最新 lastLoginAt。誰も一度もログインしていなければ null。 */
  lastUserLoginAt: Date | null;
  /** P-6: 最終活動 (lastLoginAt or createdAt) からの経過日数 (= 休眠日数の起点)。 */
  daysSinceLastActivity: number;
  /** P-6: 休眠判定 (90 日以上活動なし) を満たすかどうか。 */
  isDormant: boolean;
  // P-G (2026-05-08): 請求先情報
  billingCompanyName: string | null;
  billingContactName: string | null;
  billingContactEmail: string | null;
  billingAddress: string | null;
  billingPhoneNumber: string | null;
  paymentMethod: string;
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

  const [
    activeUserCount,
    projects,
    knowledges,
    risksIssues,
    retrospectives,
    memos,
    // P-6 (2026-05-08): テナント内最新ログイン日時 (1 ユーザでも最近ログインしていれば「活動あり」)
    lastLoginAggregate,
  ] = await Promise.all([
    prisma.user.count({ where: { tenantId, isActive: true, deletedAt: null } }),
    prisma.project.count({ where: { tenantId, deletedAt: null } }),
    prisma.knowledge.count({ where: { tenantId, deletedAt: null } }),
    prisma.riskIssue.count({ where: { tenantId, deletedAt: null } }),
    prisma.retrospective.count({ where: { tenantId, deletedAt: null } }),
    prisma.memo.count({ where: { tenantId, deletedAt: null } }),
    prisma.user.aggregate({
      where: { tenantId, deletedAt: null },
      _max: { lastLoginAt: true },
    }),
  ]);

  // P-6: 休眠日数を service 側で計算 (server component の render purity 違反を回避)
  const lastUserLoginAt = lastLoginAggregate._max.lastLoginAt ?? null;
  const referenceTime = (lastUserLoginAt ?? t.createdAt).getTime();
  const daysSinceLastActivity = Math.floor(
    (Date.now() - referenceTime) / (24 * 60 * 60 * 1000),
  );
  const isDormant = daysSinceLastActivity >= DORMANT_TENANT_THRESHOLD_DAYS;

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
    lastUserLoginAt,
    daysSinceLastActivity,
    isDormant,
    // P-G (2026-05-08): 請求先情報
    billingCompanyName: t.billingCompanyName,
    billingContactName: t.billingContactName,
    billingContactEmail: t.billingContactEmail,
    billingAddress: t.billingAddress,
    billingPhoneNumber: t.billingPhoneNumber,
    paymentMethod: t.paymentMethod,
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

/**
 * P-5b (2026-05-08): 過去 N ヶ月の月次使用量履歴を取得 (super_admin 履歴グラフ + CSV 用)。
 *
 * - tenant_monthly_usage_history からテナント x yearMonth で取得
 * - 管理テナントは元から保存されていないので除外不要 (snapshot 側で MANAGEMENT_TENANT_ID を弾いている)
 * - 並び: yearMonth 降順 (新しい月から) → tenantSeq 昇順
 *
 * @param months 取得月数 (1〜24 の範囲、それ以外はクランプ)
 * @returns 月次使用量履歴の配列
 */
export type MonthlyUsageHistoryRow = {
  yearMonth: string;
  tenantId: string;
  tenantSeq: number | null;
  tenantName: string;
  plan: string;
  apiCallCount: number;
  apiCostJpy: number;
  activeUserCount: number;
};

export async function listMonthlyUsageHistory(
  months: number = 6,
): Promise<MonthlyUsageHistoryRow[]> {
  const safeMonths = Math.max(1, Math.min(24, Math.trunc(months)));

  // 直近 N ヶ月の yearMonth を生成 (UTC ベース、当月含まない過去 N ヶ月)
  // 例: 2026-05 実行時で months=6 なら ['2026-04', '2026-03', ..., '2025-11']
  const targetYearMonths: string[] = [];
  const now = new Date();
  for (let i = 1; i <= safeMonths; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    targetYearMonths.push(ym);
  }

  const rows = await prisma.tenantMonthlyUsageHistory.findMany({
    where: { yearMonth: { in: targetYearMonths } },
    orderBy: [{ yearMonth: 'desc' }, { tenantId: 'asc' }],
    include: {
      tenant: {
        select: { tenantSeq: true, name: true },
      },
    },
  });

  return rows.map((r) => ({
    yearMonth: r.yearMonth,
    tenantId: r.tenantId,
    tenantSeq: r.tenant.tenantSeq,
    tenantName: r.tenant.name,
    plan: r.plan,
    apiCallCount: r.apiCallCount,
    apiCostJpy: r.apiCostJpy,
    activeUserCount: r.activeUserCount,
  }));
}

/**
 * P-6 (2026-05-08): 休眠テナントの判定しきい値 (日数)。
 *
 * super_admin ダッシュボードの「休眠テナント警告」で
 * `daysSinceLastLogin >= DORMANT_TENANT_THRESHOLD_DAYS` のテナントを警告対象とする。
 *
 * V1_FINAL_TASKS.md P-6 仕様の「90 日連続休眠テナント」を採用。
 */
export const DORMANT_TENANT_THRESHOLD_DAYS = 90;

/**
 * P-6 (2026-05-08): 休眠テナント判定の出力 1 行。
 */
export type DormantTenantRow = {
  id: string;
  tenantSeq: number | null;
  name: string;
  plan: string;
  /** テナント内 **任意** ユーザの最新ログイン日時。誰も一度もログインしていなければ null。 */
  lastUserLoginAt: Date | null;
  /** テナント作成日時 (新規 onboarding 中かを判別するため) */
  createdAt: Date;
  /**
   * 休眠日数。lastUserLoginAt があればそこから今日まで、なければ createdAt から今日まで。
   * `null` (= 計算不能) は発生しない (= getCurrentDate との比較で常に数値)。
   */
  daysSinceLastActivity: number;
};

/**
 * P-6 (2026-05-08): 休眠テナント一覧を取得 (super_admin ダッシュボード警告用)。
 *
 * 判定基準:
 *   - 顧客テナント (= MANAGEMENT_TENANT_ID 以外、deletedAt = null)
 *   - **テナント内にいずれのユーザもログインしていない期間 ≥ thresholdDays**
 *     - すべてのユーザの lastLoginAt がしきい値より古い
 *     - もしくは誰も一度もログインしておらず、テナント作成からしきい値経過
 *   - **新規 onboarding 期間 (createdAt < thresholdDays 前) は除外**
 *     (= 作成直後のテナントは「まだ動き出していないだけ」で休眠ではない)
 *
 * 並び順: 休眠日数の長い順 (= 一番危険なものを上に)
 *
 * @param thresholdDays 休眠判定しきい値 (デフォルト 90 日 = DORMANT_TENANT_THRESHOLD_DAYS)
 * @param now 計算基準時刻 (テスト用)
 */
export async function listDormantTenants(
  thresholdDays: number = DORMANT_TENANT_THRESHOLD_DAYS,
  now: Date = new Date(),
): Promise<DormantTenantRow[]> {
  const cutoffDate = new Date(now.getTime() - thresholdDays * 24 * 60 * 60 * 1000);

  // 顧客テナント全件 (管理テナント・削除済みは除外) + テナント内最新ログインを集計
  const tenants = await prisma.tenant.findMany({
    where: {
      id: { not: MANAGEMENT_TENANT_ID },
      deletedAt: null,
      // onboarding 期間 (作成 < thresholdDays 前) は休眠判定対象外
      createdAt: { lte: cutoffDate },
    },
    orderBy: { tenantSeq: 'asc' },
    select: {
      id: true,
      tenantSeq: true,
      name: true,
      plan: true,
      createdAt: true,
    },
  });

  if (tenants.length === 0) return [];

  // テナント内最新ログイン日時を groupBy で 1 クエリ取得 (N+1 回避)
  const lastLogins = await prisma.user.groupBy({
    by: ['tenantId'],
    where: {
      tenantId: { in: tenants.map((t) => t.id) },
      deletedAt: null,
    },
    _max: { lastLoginAt: true },
  });
  const lastLoginByTenant = new Map(
    lastLogins.map((l) => [l.tenantId, l._max.lastLoginAt]),
  );

  const rows: DormantTenantRow[] = [];
  for (const t of tenants) {
    const lastLogin = lastLoginByTenant.get(t.id) ?? null;

    // 休眠判定:
    //   - 誰も一度もログインしていない: テナント作成からの経過日数で判定
    //   - 誰かがログインしたことがある: その最新時刻からの経過日数で判定
    const referenceTime = lastLogin?.getTime() ?? t.createdAt.getTime();
    const daysSinceLastActivity = Math.floor(
      (now.getTime() - referenceTime) / (24 * 60 * 60 * 1000),
    );

    if (daysSinceLastActivity >= thresholdDays) {
      rows.push({
        id: t.id,
        tenantSeq: t.tenantSeq,
        name: t.name,
        plan: t.plan,
        lastUserLoginAt: lastLogin,
        createdAt: t.createdAt,
        daysSinceLastActivity,
      });
    }
  }

  // 休眠日数降順 (危険度の高い順)
  rows.sort((a, b) => b.daysSinceLastActivity - a.daysSinceLastActivity);
  return rows;
}
