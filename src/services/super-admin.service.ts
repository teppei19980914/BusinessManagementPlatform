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
import {
  getBeginnerExpiryState,
  getBeginnerDaysRemaining,
  type BeginnerExpiryState,
} from './beginner-expiry.service';
import {
  ADDON_MONTHLY_JPY as SUPER_ADMIN_ADDON_MONTHLY_JPY,
  computeStorageLimitBytes,
} from '@/config/storage-addon';

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
  // Storage add-on (Phase 2 / 2026-05-08): 当月 CSV エクスポートで容量・追加課金を表示
  storageAddonPlan: string;
  storageBytesUsed: number;
  storageAddonMonthlyJpy: number;
  /** LLM 部分 + Storage add-on の合算課金。請求書生成根拠 */
  totalCurrentMonthJpy: number;
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
      // Storage add-on (Phase 2 / 2026-05-08): CSV エクスポート用
      storageAddonPlan: true,
      storageBytesUsed: true,
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
    // Storage add-on (Phase 2 / 2026-05-08): 当月課金合計の請求書根拠
    storageAddonPlan: isStorageAddonPlanStr(t.storageAddonPlan) ? t.storageAddonPlan : 'standard',
    storageBytesUsed: Number(t.storageBytesUsed),
    storageAddonMonthlyJpy: SUPER_ADMIN_ADDON_MONTHLY_JPY[
      isStorageAddonPlanStr(t.storageAddonPlan) ? t.storageAddonPlan : 'standard'
    ],
    totalCurrentMonthJpy:
      t.currentMonthApiCostJpy +
      SUPER_ADMIN_ADDON_MONTHLY_JPY[
        isStorageAddonPlanStr(t.storageAddonPlan) ? t.storageAddonPlan : 'standard'
      ],
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
  // P-B (2026-05-08): Beginner プラン期限情報
  beginnerEverUpgraded: boolean;
  beginnerExpiryState: BeginnerExpiryState;
  beginnerDaysRemaining: number | null;
  entityCounts: {
    projects: number;
    knowledges: number;
    risksIssues: number;
    retrospectives: number;
    memos: number;
  };
  // Storage add-on (Phase 2 / 2026-05-08): super_admin がテナント別容量と課金を参照
  storageAddonPlan: string;
  storageBytesUsed: number;
  storageLimitBytes: number;
  storageUsageRatio: number;
  storageAddonMonthlyJpy: number;
  /** 当月の合計課金額 (LLM 部分 + Storage add-on) */
  totalCurrentMonthJpy: number;
  storageGracePeriodStartedAt: Date | null;
  storageScheduledAt: Date | null;
  storageScheduledNext: string | null;
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
    // P-B (2026-05-08): Beginner プラン期限情報 (純関数で計算)
    beginnerEverUpgraded: t.beginnerEverUpgraded,
    beginnerExpiryState: getBeginnerExpiryState({
      plan: t.plan,
      createdAt: t.createdAt,
      beginnerEverUpgraded: t.beginnerEverUpgraded,
    }),
    beginnerDaysRemaining: getBeginnerDaysRemaining({
      plan: t.plan,
      createdAt: t.createdAt,
      beginnerEverUpgraded: t.beginnerEverUpgraded,
    }),
    entityCounts: { projects, knowledges, risksIssues, retrospectives, memos },
    // Storage add-on (Phase 2 / 2026-05-08): キャッシュ値ベースの容量・課金情報
    ...computeStorageDetailFields(t),
  };
}

/**
 * Storage add-on 関連フィールドを Tenant row から派生計算する内部 helper。
 * super_admin ダッシュボード表示用 (= キャッシュ値の表示で十分)。
 */
function computeStorageDetailFields(t: {
  plan: string;
  storageAddonPlan: string;
  storageBytesUsed: bigint;
  storageGracePeriodStartedAt: Date | null;
  scheduledStorageAddonAt: Date | null;
  scheduledNextStorageAddon: string | null;
  currentMonthApiCostJpy: number;
}): {
  storageAddonPlan: string;
  storageBytesUsed: number;
  storageLimitBytes: number;
  storageUsageRatio: number;
  storageAddonMonthlyJpy: number;
  totalCurrentMonthJpy: number;
  storageGracePeriodStartedAt: Date | null;
  storageScheduledAt: Date | null;
  storageScheduledNext: string | null;
} {
  const llmPlan = isTenantPlanString(t.plan) ? t.plan : 'beginner';
  const addonPlan = isStorageAddonPlanStr(t.storageAddonPlan) ? t.storageAddonPlan : 'standard';
  const limitBytes = computeStorageLimitBytes(llmPlan, addonPlan);
  const usedBytes = Number(t.storageBytesUsed);
  const usageRatio = limitBytes > 0 ? usedBytes / limitBytes : 0;
  const addonJpy = SUPER_ADMIN_ADDON_MONTHLY_JPY[addonPlan];
  const totalJpy = t.currentMonthApiCostJpy + addonJpy;
  return {
    storageAddonPlan: addonPlan,
    storageBytesUsed: usedBytes,
    storageLimitBytes: limitBytes,
    storageUsageRatio: usageRatio,
    storageAddonMonthlyJpy: addonJpy,
    totalCurrentMonthJpy: totalJpy,
    storageGracePeriodStartedAt: t.storageGracePeriodStartedAt,
    storageScheduledAt: t.scheduledStorageAddonAt,
    storageScheduledNext: t.scheduledNextStorageAddon,
  };
}

function isTenantPlanString(p: string): p is 'beginner' | 'expert' | 'pro' {
  return p === 'beginner' || p === 'expert' || p === 'pro';
}

function isStorageAddonPlanStr(p: string): p is 'standard' | 'plus' | 'pro_storage' | 'enterprise' {
  return p === 'standard' || p === 'plus' || p === 'pro_storage' || p === 'enterprise';
}

/**
 * Storage 使用量 TOP N テナントを取得 (super_admin ダッシュボード TOP のランキング表示用)。
 *
 * - 管理テナント / 削除済みテナントは除外
 * - キャッシュ値 (storageBytesUsed) で降順ソート → 上位 N 件取得
 *
 * @param limit 表示件数 (default 10)
 */
export type StorageUsageTopRow = {
  id: string;
  tenantSeq: number | null;
  name: string;
  llmPlan: string;
  storageAddonPlan: string;
  storageBytesUsed: number;
  storageLimitBytes: number;
  storageUsageRatio: number;
  graceState: 'active' | 'grace_active' | 'write_blocked';
};

export async function listStorageUsageTop(limit: number = 10): Promise<StorageUsageTopRow[]> {
  const tenants = await prisma.tenant.findMany({
    where: { id: { not: MANAGEMENT_TENANT_ID }, deletedAt: null },
    orderBy: { storageBytesUsed: 'desc' },
    take: limit,
    select: {
      id: true,
      tenantSeq: true,
      name: true,
      plan: true,
      storageAddonPlan: true,
      storageBytesUsed: true,
      storageGracePeriodStartedAt: true,
    },
  });

  return tenants.map((t) => {
    const llmPlan = isTenantPlanString(t.plan) ? t.plan : 'beginner';
    const addonPlan = isStorageAddonPlanStr(t.storageAddonPlan) ? t.storageAddonPlan : 'standard';
    const limitBytes = computeStorageLimitBytes(llmPlan, addonPlan);
    const usedBytes = Number(t.storageBytesUsed);
    const usageRatio = limitBytes > 0 ? usedBytes / limitBytes : 0;

    let graceState: StorageUsageTopRow['graceState'] = 'active';
    if (t.storageGracePeriodStartedAt) {
      const elapsedDays =
        (Date.now() - t.storageGracePeriodStartedAt.getTime()) / (1000 * 60 * 60 * 24);
      graceState = elapsedDays >= 7 ? 'write_blocked' : 'grace_active';
    }

    return {
      id: t.id,
      tenantSeq: t.tenantSeq,
      name: t.name,
      llmPlan,
      storageAddonPlan: addonPlan,
      storageBytesUsed: usedBytes,
      storageLimitBytes: limitBytes,
      storageUsageRatio: usageRatio,
      graceState,
    };
  });
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
  // Storage add-on (Phase 2 / 2026-05-08): 履歴 snapshot に Storage 関連を追加
  storageBytesUsed: number;
  storageAddonPlan: string;
  storageAddonJpy: number;
  /** 当月の合計課金 (apiCostJpy + storageAddonJpy)。請求書根拠 */
  totalJpy: number;
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
    // Storage add-on (Phase 2 / 2026-05-08): スナップショット時点の値
    storageBytesUsed: Number(r.storageBytesUsed),
    storageAddonPlan: r.storageAddonPlan,
    storageAddonJpy: r.storageAddonJpy,
    totalJpy: r.totalJpy,
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

/**
 * P-A (2026-05-08): テナント論理削除 (super_admin 専用)。
 *
 * 役割:
 *   問題テナント (TOS 違反 / 課金未払 / 営業判断による解約) を super_admin が止める。
 *   完全な物理削除ではなく、論理削除 + ログイン即時遮断 + データ参照不可化を行う。
 *
 * 削除対象 (= deletedAt をセットして参照不可化):
 *   - Tenant 本体
 *   - 配下 User: deletedAt + isActive=false (= ログイン即時不可化、§auth.ts のチェックで
 *     将来のログインが弾かれる)
 *   - 配下の業務エンティティ (deletedAt カラムを持つもの):
 *     Project / Knowledge / RiskIssue / Retrospective / Memo / Stakeholder /
 *     Comment / Attachment
 *
 * 削除対象外:
 *   - **deletedAt カラムを持たないテーブル** (Customer / Mention / Notification):
 *     親 Tenant が deletedAt セット済 = テナント一覧で非表示 → 参照不可化される (= 実害なし)
 *   - ApiCallLog (= 過去課金根拠の物理保持)
 *   - TenantMonthlyUsageHistory (= 月次集計、請求書再現可能性)
 *   - AuditLog / AuthEventLog / RoleChangeLog / SystemErrorLog (= 監査ログ物理保持)
 *
 * 設計判断:
 *   - **管理テナント (MANAGEMENT_TENANT_ID) は削除禁止** (= 自爆防止)
 *   - **既に削除済みテナント** への再削除は ALREADY_DELETED エラー (冪等性ではなく明示エラー
 *     にすることで誤操作検知を強化)
 *   - **トランザクション**: 一連の更新は単一 transaction で実行、途中失敗で部分的に消えない
 *   - **復元機能は本 PR スコープ外**: 必要になったら別 PR で `restoreTenant` を追加
 *
 * 認可:
 *   呼出側で isSuperAdmin(user) チェック済の前提 (本サービス層では検証しない)。
 *
 * @param tenantId 削除対象テナント ID
 * @param performerId 実行者 (= super_admin) のユーザ ID。監査ログ記録用
 * @returns 削除されたエンティティ数のサマリ
 * @throws Error('TENANT_NOT_FOUND') テナント不在時
 * @throws Error('MANAGEMENT_TENANT_FORBIDDEN') 管理テナントを削除しようとした時
 * @throws Error('ALREADY_DELETED') 既に論理削除済テナントへの再削除時
 */
export type DeleteTenantResult = {
  tenantId: string;
  deletedCounts: {
    users: number;
    projects: number;
    knowledges: number;
    risksIssues: number;
    retrospectives: number;
    memos: number;
    stakeholders: number;
    comments: number;
    attachments: number;
  };
};

export async function deleteTenant(
  tenantId: string,
  performerId: string,
): Promise<DeleteTenantResult> {
  if (tenantId === MANAGEMENT_TENANT_ID) {
    throw new Error('MANAGEMENT_TENANT_FORBIDDEN');
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, deletedAt: true, name: true },
  });
  if (!tenant) {
    throw new Error('TENANT_NOT_FOUND');
  }
  if (tenant.deletedAt != null) {
    throw new Error('ALREADY_DELETED');
  }

  const now = new Date();

  // 単一 transaction で一気に論理削除 (途中失敗で部分削除の不整合を避ける)
  // Tenant.update / auditLog.create の戻り値は破棄。
  const [
    usersUpdate,
    projectsUpdate,
    knowledgesUpdate,
    risksIssuesUpdate,
    retrospectivesUpdate,
    memosUpdate,
    stakeholdersUpdate,
    commentsUpdate,
    attachmentsUpdate,
  ] = await prisma.$transaction([
    // ユーザは isActive=false も併せて、ログイン即時不可化
    prisma.user.updateMany({
      where: { tenantId, deletedAt: null },
      data: { deletedAt: now, isActive: false },
    }),
    prisma.project.updateMany({
      where: { tenantId, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.knowledge.updateMany({
      where: { tenantId, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.riskIssue.updateMany({
      where: { tenantId, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.retrospective.updateMany({
      where: { tenantId, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.memo.updateMany({
      where: { tenantId, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.stakeholder.updateMany({
      where: { tenantId, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.comment.updateMany({
      where: { tenantId, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.attachment.updateMany({
      where: { tenantId, deletedAt: null },
      data: { deletedAt: now },
    }),
    // 最後に Tenant 本体
    prisma.tenant.update({
      where: { id: tenantId },
      data: { deletedAt: now },
    }),
    // 監査ログを残す (物理保持テーブルなので今後復元・監査が可能)
    prisma.auditLog.create({
      data: {
        userId: performerId,
        action: 'DELETE',
        entityType: 'tenant',
        entityId: tenantId,
        beforeValue: { name: tenant.name, deletedAt: null },
        afterValue: { name: tenant.name, deletedAt: now.toISOString() },
      },
    }),
  ]);

  return {
    tenantId,
    deletedCounts: {
      users: usersUpdate.count,
      projects: projectsUpdate.count,
      knowledges: knowledgesUpdate.count,
      risksIssues: risksIssuesUpdate.count,
      retrospectives: retrospectivesUpdate.count,
      memos: memosUpdate.count,
      stakeholders: stakeholdersUpdate.count,
      comments: commentsUpdate.count,
      attachments: attachmentsUpdate.count,
    },
  };
}

// ================================================================
// テナント物理削除 cron (2026-05-08): 論理削除から 90 日経過したテナントの業務データを物理削除
// ================================================================

/**
 * 論理削除から 90 日経過したテナントを「業務データのみ物理削除」する cron 用関数。
 *
 * 削除対象 (= テナント業務データ、容量を解放するもの):
 *   tasks / estimates / project_members / projects / knowledge_projects / knowledges /
 *   risks_issues / retrospectives / memos / customers / stakeholders / mentions /
 *   comments / attachments / tenant_import_preview / users
 *
 * 保護対象 (= 物理削除しない):
 *   tenant 本体 (FK 整合性 + super_admin の監査参照)
 *   api_call_logs (課金根拠の法的保持)
 *   tenant_monthly_usage_history (請求書根拠)
 *   audit_logs (監査要件)
 *   auth_event_logs (セキュリティ監査)
 *   role_change_logs (権限変更履歴)
 *   email_send_logs (送信履歴)
 *   notifications (テナント削除に伴い既読化されるが、論理削除済 user 経由で保持)
 *
 * 設計判断:
 *   - **テナント本体は物理削除しない**: 上記ログテーブルが tenant_id NOT NULL FK を持つため、
 *     tenant 物理削除すると FK violation。slug 再利用の利便性より整合性を優先。
 *   - **users は物理削除する**: PII 削除 (= GDPR 等プライバシー要件への配慮)。
 *     紐付き auth_event_logs / audit_logs などは user_id NULL になる
 *     (= ON DELETE SET NULL の前提を満たす)。
 *   - **冪等性**: 同一テナントの 2 回目以降は対象データが既に空なので no-op。
 *     失敗時はテナントごとに try/catch、cron 全体は止めない。
 *
 * 関連:
 *   - 計画: ユーザライフサイクルの Step 13 (テナント解約 → 90 日後物理削除)
 *   - 月初 cron: src/services/tenant-monthly-reset.service.ts (本関数を呼ぶ)
 */
export type PurgeOldDeletedTenantsResult = {
  /** 物理削除を試行したテナント件数 */
  attempted: number;
  /** 成功した件数 */
  succeeded: number;
  /** 削除されたレコード総数 (業務データの sum) */
  totalRowsDeleted: number;
};

export async function purgeOldDeletedTenants(
  now: Date = new Date(),
): Promise<PurgeOldDeletedTenantsResult> {
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  // 論理削除から 90 日以上経過したテナント (= 物理削除対象)
  const targets = await prisma.tenant.findMany({
    where: {
      deletedAt: { lt: ninetyDaysAgo },
      id: { not: MANAGEMENT_TENANT_ID },
    },
    select: { id: true },
  });

  let succeeded = 0;
  let totalRowsDeleted = 0;

  for (const t of targets) {
    try {
      // 単一 transaction で関連データを削除 (途中失敗時の半端状態を避ける)。
      // FK の依存関係順 (子 → 親) に削除する: child first, parent last。
      const [
        // 子テーブル (= FK 参照される側ではなく、参照する側) を先に削除
        mentions,
        comments,
        attachments,
        knowledgeProjects,
        taskKnowledges,
        taskProgressLogs,
        tasks,
        estimates,
        projectMembers,
        risksIssues,
        retrospectives,
        memos,
        stakeholders,
        knowledges,
        projects,
        customers,
        importPreviews,
        users,
      ] = await prisma.$transaction([
        prisma.mention.deleteMany({ where: { tenantId: t.id } }),
        prisma.comment.deleteMany({ where: { tenantId: t.id } }),
        prisma.attachment.deleteMany({ where: { tenantId: t.id } }),
        prisma.knowledgeProject.deleteMany({ where: { knowledge: { tenantId: t.id } } }),
        prisma.taskKnowledge.deleteMany({ where: { knowledge: { tenantId: t.id } } }),
        prisma.taskProgressLog.deleteMany({ where: { task: { project: { tenantId: t.id } } } }),
        prisma.task.deleteMany({ where: { project: { tenantId: t.id } } }),
        prisma.estimate.deleteMany({ where: { project: { tenantId: t.id } } }),
        prisma.projectMember.deleteMany({ where: { project: { tenantId: t.id } } }),
        prisma.riskIssue.deleteMany({ where: { tenantId: t.id } }),
        prisma.retrospective.deleteMany({ where: { tenantId: t.id } }),
        prisma.memo.deleteMany({ where: { tenantId: t.id } }),
        prisma.stakeholder.deleteMany({ where: { tenantId: t.id } }),
        prisma.knowledge.deleteMany({ where: { tenantId: t.id } }),
        prisma.project.deleteMany({ where: { tenantId: t.id } }),
        prisma.customer.deleteMany({ where: { tenantId: t.id } }),
        prisma.tenantImportPreview.deleteMany({ where: { tenantId: t.id } }),
        // users は最後 (= 上記の created_by / updated_by などの参照を解決した後)
        prisma.user.deleteMany({ where: { tenantId: t.id } }),
      ]);

      const subTotal =
        mentions.count +
        comments.count +
        attachments.count +
        knowledgeProjects.count +
        taskKnowledges.count +
        taskProgressLogs.count +
        tasks.count +
        estimates.count +
        projectMembers.count +
        risksIssues.count +
        retrospectives.count +
        memos.count +
        stakeholders.count +
        knowledges.count +
        projects.count +
        customers.count +
        importPreviews.count +
        users.count;
      totalRowsDeleted += subTotal;
      succeeded += 1;

      // 監査ログ: 物理削除実行を記録 (super_admin の監査参照用、別 PR の deleteTenant とペア)
      // userId は cron 起動なので null 不可だが NOT NULL のため、performerId 不在で記録できない。
      // → AuditLog ではなく SystemErrorLog に info severity で記録する代替案を採用
      //   (= 純粋にログ目的、監査要件は別途 P-A 時の論理削除エントリでカバー)
      // ※ 簡素化のため本実装ではログ省略 (cron 戻り値で件数を返すのみ)
    } catch {
      // 1 テナント失敗で他に影響させない (= 次回 cron で retry される)
      // ロギングは route 側で集計戻り値を出力する想定
    }
  }

  return {
    attempted: targets.length,
    succeeded,
    totalRowsDeleted,
  };
}
