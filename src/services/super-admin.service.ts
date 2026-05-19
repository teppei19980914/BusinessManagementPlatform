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
import { MANAGEMENT_TENANT_ID, DEFAULT_TENANT_ID } from '@/lib/tenant';
// PR-V7 #1 (2026-05-19): credit_card 払いテナント解約時に Stripe Subscription を停止し
//   Storage add-on 等の固定費が永続引落されるのを防ぐため。
import { isStripeEnabled } from '@/lib/stripe';
import { cancelTenantStripeSubscription } from './stripe-billing.service';

/**
 * super_admin ダッシュボードの **顧客集計** (=請求対象テナントの合算) から除外するテナント。
 *
 *   - 管理テナント (MANAGEMENT_TENANT_ID): プラットフォーム運営者用、課金対象外
 *   - default テナント (DEFAULT_TENANT_ID): 運営者自身のテナント。請求先 = 運営者 のため
 *     顧客課金集計には含めない (= 売上扱いしない)
 *
 * 2026-05-11 改訂: Default テナントを「顧客集計」からは除外したまま、画面上には
 *   別セクション (= 「Default テナント (運営者自身)」) として情報を表示する方針に変更。
 *   旧仕様 (PR E / #19) は集計からも画面表示からも完全に除外していたが、運営者が
 *   自身のテナントの状況を super_admin ダッシュボードで一括管理したいニーズを反映。
 *   - 顧客集計クエリ: 本定数で除外 (= 不変)
 *   - Default テナント自身の情報: `getDefaultTenantOwnSummary` で個別取得し別セクション表示
 */
const SUPER_ADMIN_EXCLUDED_TENANT_IDS = [MANAGEMENT_TENANT_ID, DEFAULT_TENANT_ID];
import {
  getBeginnerExpiryState,
  getBeginnerDaysRemaining,
  type BeginnerExpiryState,
} from './beginner-expiry.service';
import {
  ADDON_MONTHLY_JPY as SUPER_ADMIN_ADDON_MONTHLY_JPY,
  computeStorageLimitBytes,
  isStorageAddonPlan,
} from '@/config/storage-addon';
import { getTenantCurrentYearMonth } from '@/lib/tenant-time';

/**
 * 全テナント一覧 (super_admin ダッシュボード用)。
 *
 * 含めるテナント: 顧客テナント (= MANAGEMENT_TENANT_ID 以外、deletedAt=null)
 * 含めないもの: 管理テナント (運営内部) / 論理削除済み
 *
 * 各テナントには使用量集計とアクティブユーザ数を含める。
 *
 * 2026-05-14: 月途中解約テナントの請求漏れ検知用に `includeDeleted` フラグを追加。
 *   true の場合は解約済テナント (deletedAt != null) も結果に含め、`deletedAt` をそのまま返す。
 *   super_admin の月次請求業務で「解約日 = いつまで請求するか」の判別に使用する。
 *   詳細: docs/operations/BILLING_MONTHLY_OPERATIONS.md
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
  /** 2026-05-14: 解約日 (null = アクティブ、Date = 解約済)。請求対象期間の判別に使用 */
  deletedAt: Date | null;
  /** 2026-05-14 (PR #372): 停止日 (null = 通常運用、Date = read-only 強制移行中) */
  suspendedAt: Date | null;
  /** 2026-05-14 (PR #372): 停止理由 ('payment_delinquent' / 'tos_violation' / 'other') */
  suspendReason: string | null;
  // P-G (2026-05-08): 請求先情報 (CSV エクスポート + super_admin 一覧表示用) / PR C で拡張
  billingType: string;
  billingCompanyName: string | null;
  billingContactName: string | null;
  billingContactEmail: string | null;
  /** Legacy: 旧 単一 Text 住所 (新規入力なし) */
  billingAddress: string | null;
  billingPostalCode: string | null;
  billingPrefecture: string | null;
  billingCity: string | null;
  billingStreetAddress: string | null;
  billingBuildingName: string | null;
  billingPhoneNumber: string | null;
  paymentMethod: string;
  // Storage add-on (Phase 2 / 2026-05-08): 当月 CSV エクスポートで容量・追加課金を表示
  storageAddonPlan: string;
  storageBytesUsed: number;
  storageAddonMonthlyJpy: number;
  /** LLM 部分 + Storage add-on の合算課金。請求書生成根拠 */
  totalCurrentMonthJpy: number;
};

export type ListAllTenantsOptions = {
  /**
   * 2026-05-14: 解約済テナント (deletedAt != null) も結果に含めるか。
   * default false (= 従来通り、アクティブテナントのみ)。
   * 月次請求業務で「月途中解約の取りこぼし防止」のため true で呼び出す。
   */
  includeDeleted?: boolean;
};

export async function listAllTenants(
  options: ListAllTenantsOptions = {},
): Promise<TenantSummaryRow[]> {
  const includeDeleted = options.includeDeleted === true;
  const tenants = await prisma.tenant.findMany({
    where: {
      // 2026-05-09 (PR E / #19): 管理テナント + default テナントを除外
      id: { notIn: SUPER_ADMIN_EXCLUDED_TENANT_IDS },
      // 2026-05-14: includeDeleted=false の場合のみ deletedAt フィルタを適用
      ...(includeDeleted ? {} : { deletedAt: null }),
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
      // 2026-05-14: 解約済テナント識別 (月途中解約の請求漏れ検知用)
      deletedAt: true,
      // 2026-05-14 (PR #372): read-only 強制移行状態 (super_admin UI / CSV 表示用)
      suspendedAt: true,
      suspendReason: true,
      // P-G (2026-05-08): 請求先情報 / PR C (2026-05-09 #5/#8/#10) で拡張
      billingType: true,
      billingCompanyName: true,
      billingContactName: true,
      billingContactEmail: true,
      billingAddress: true,
      billingPostalCode: true,
      billingPrefecture: true,
      billingCity: true,
      billingStreetAddress: true,
      billingBuildingName: true,
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
    // 2026-05-14: 解約日 (請求対象期間の判別用)
    deletedAt: t.deletedAt,
    // 2026-05-14 (PR #372): read-only 強制移行状態
    suspendedAt: t.suspendedAt,
    suspendReason: t.suspendReason,
    // P-G (2026-05-08): 請求先情報 / PR C (2026-05-09)
    billingType: t.billingType,
    billingCompanyName: t.billingCompanyName,
    billingContactName: t.billingContactName,
    billingContactEmail: t.billingContactEmail,
    billingAddress: t.billingAddress,
    billingPostalCode: t.billingPostalCode,
    billingPrefecture: t.billingPrefecture,
    billingCity: t.billingCity,
    billingStreetAddress: t.billingStreetAddress,
    billingBuildingName: t.billingBuildingName,
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
  // P-G (2026-05-08) + PR C (2026-05-09): 請求先情報。
  //   実際のフィールド (billingType / billingCompanyName / billingPostalCode 等) は
  //   TenantSummaryRow から継承 (`& TenantSummaryRow` で intersection)。
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
    // 2026-05-14: TenantSummaryRow 継承のため必須。getTenantDetail は deletedAt: null
    //   フィルタを当てているため、ここに来た時点で常に null。
    deletedAt: t.deletedAt,
    // 2026-05-14 (PR #372): read-only 強制移行状態
    suspendedAt: t.suspendedAt,
    suspendReason: t.suspendReason,
    beginnerMonthlyCallLimit: t.beginnerMonthlyCallLimit,
    beginnerMaxSeats: t.beginnerMaxSeats,
    scheduledPlanChangeAt: t.scheduledPlanChangeAt,
    scheduledNextPlan: t.scheduledNextPlan,
    lastUserLoginAt,
    daysSinceLastActivity,
    isDormant,
    // P-G (2026-05-08) + PR C (2026-05-09): 請求先情報
    billingType: t.billingType,
    billingCompanyName: t.billingCompanyName,
    billingContactName: t.billingContactName,
    billingContactEmail: t.billingContactEmail,
    billingAddress: t.billingAddress,
    billingPostalCode: t.billingPostalCode,
    billingPrefecture: t.billingPrefecture,
    billingCity: t.billingCity,
    billingStreetAddress: t.billingStreetAddress,
    billingBuildingName: t.billingBuildingName,
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
  const addonPlan = isStorageAddonPlanStr(t.storageAddonPlan) ? t.storageAddonPlan : 'standard';
  // PR-3 (2026-05-15): 20MB + add-on 拡張 (LLM プラン非依存)
  const limitBytes = computeStorageLimitBytes(addonPlan);
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
    // 2026-05-09 (PR E / #19): 管理テナント + default テナントを除外
    where: { id: { notIn: SUPER_ADMIN_EXCLUDED_TENANT_IDS }, deletedAt: null },
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
    // PR-3 (2026-05-15): llmPlan は表示用のみ (上限計算には使わない)
    const llmPlan = isTenantPlanString(t.plan) ? t.plan : 'beginner';
    const addonPlan = isStorageAddonPlanStr(t.storageAddonPlan) ? t.storageAddonPlan : 'standard';
    const limitBytes = computeStorageLimitBytes(addonPlan);
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
  /** LLM 部分の当月内部請求額合計 (Storage は除く) */
  totalCurrentMonthApiCostJpy: number;
  /**
   * Storage add-on の月額合計 (= 顧客テナントの storage_addon_plan ベース固定額の総和)。
   * 2026-05-11: 「ストレージプラン (容量 add-on) も考慮した費用 UI」の実装で追加。
   */
  totalCurrentMonthStorageJpy: number;
  /** LLM + Storage 合算の当月請求額 (請求書の根拠合計) */
  totalCurrentMonthCombinedJpy: number;
  planDistribution: { plan: string; count: number }[];
};

export async function getCrossTenantUsageSummary(): Promise<CrossTenantUsageSummary> {
  // 管理テナント + default テナントを「顧客集計」から除外
  // (Default テナント自身の情報は getDefaultTenantOwnSummary で別取得)
  const tenantWhere = {
    id: { notIn: SUPER_ADMIN_EXCLUDED_TENANT_IDS },
    deletedAt: null,
  };

  // ★ PR-V8.1 (2026-05-19) 請求 invariant: 顧客集計を ApiCallLog SUM (真値) ベースに変更。
  //   旧設計は `Tenant.currentMonthApiCallCount/CostJpy` (= counter) の SUM を集計していたが、
  //   counter が drift している場合、顧客全体の合計課金額表示が誤り、請求業務オペレータが
  //   間違った数字で運用判断する致命的事故になる (= ユーザ運営の事業継続性に直結)。
  //   ApiCallLog は不変監査ログのため真値であり、ここから直接集計する。
  //   月境界はテナント TZ ベース。複数 TZ テナント混在環境では各テナントの月初を尊重するため
  //   per-tenant で reconcileTenantApiUsage を呼ぶ必要があるが、ここは「全テナント横断の運営
  //   指標」用途なので UTC 月初固定で集計する (= テナント TZ 集約は billing-aggregation 側で実施)。
  const utcMonthStart = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
  );

  const [tenantCount, apiAgg, planGroups, activeUsersAgg, storageGroups] = await Promise.all([
    prisma.tenant.count({ where: tenantWhere }),
    // ★ ApiCallLog SUM (真値) で集計
    prisma.apiCallLog.aggregate({
      where: {
        tenantId: { notIn: SUPER_ADMIN_EXCLUDED_TENANT_IDS },
        createdAt: { gte: utcMonthStart },
      },
      _count: { _all: true },
      _sum: { costJpy: true },
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
        tenantId: { notIn: SUPER_ADMIN_EXCLUDED_TENANT_IDS },
      },
    }),
    // 2026-05-11: Storage add-on プラン別件数を取得し、固定月額の合計を計算
    prisma.tenant.groupBy({
      by: ['storageAddonPlan'],
      where: tenantWhere,
      _count: { id: true },
    }),
  ]);

  const totalCurrentMonthApiCostJpy = apiAgg._sum.costJpy ?? 0;
  const totalCurrentMonthStorageJpy = storageGroups.reduce((acc, g) => {
    const plan = isStorageAddonPlanStr(g.storageAddonPlan) ? g.storageAddonPlan : 'standard';
    return acc + SUPER_ADMIN_ADDON_MONTHLY_JPY[plan] * g._count.id;
  }, 0);

  return {
    tenantCount,
    totalActiveUsers: activeUsersAgg,
    totalCurrentMonthApiCalls: apiAgg._count._all,
    totalCurrentMonthApiCostJpy,
    totalCurrentMonthStorageJpy,
    totalCurrentMonthCombinedJpy: totalCurrentMonthApiCostJpy + totalCurrentMonthStorageJpy,
    planDistribution: planGroups.map((p) => ({ plan: p.plan, count: p._count.id })),
  };
}

// ================================================================
// 2026-05-11: Default テナント (運営者自身) のサマリ
// ================================================================

/**
 * Default テナント (運営者自身) のサマリ。
 *
 * 役割:
 *   super_admin ダッシュボードで、運営者が自身のテナント情報を顧客テナントと別セクションで
 *   一括確認できるようにする。請求対象外のため `getCrossTenantUsageSummary` の合計集計には
 *   含めず、ここで個別に取得する。
 *
 * テナント不在時 (= seed 未投入 / 削除済) は `null` を返す。
 */
export type DefaultTenantOwnSummary = {
  id: string;
  tenantSeq: number | null;
  slug: string;
  name: string;
  plan: string;
  createdAt: Date;
  activeUserCount: number;
  currentMonthApiCallCount: number;
  /** 内部記録値。Default テナントは請求対象外のため表示は「(請求対象外)」扱い */
  currentMonthApiCostJpy: number;
  storageAddonPlan: string;
  storageBytesUsed: number;
  storageLimitBytes: number;
  storageUsageRatio: number;
};

export async function getDefaultTenantOwnSummary(): Promise<DefaultTenantOwnSummary | null> {
  const t = await prisma.tenant.findFirst({
    where: { id: DEFAULT_TENANT_ID, deletedAt: null },
    select: {
      id: true,
      tenantSeq: true,
      slug: true,
      name: true,
      plan: true,
      createdAt: true,
      currentMonthApiCallCount: true,
      currentMonthApiCostJpy: true,
      storageAddonPlan: true,
      storageBytesUsed: true,
    },
  });
  if (!t) return null;

  const activeUserCount = await prisma.user.count({
    where: { tenantId: DEFAULT_TENANT_ID, isActive: true, deletedAt: null },
  });

  // PR-3 (§5.X+27, 2026-05-15): computeStorageLimitBytes は LLM プランから切り離され
  //   `addonPlan` (Standard 20MB + add-on extra) のみで計算する 1 引数シグネチャ。
  //   旧 2 引数呼び出しが merge resolution で残存していたため修正 (PR #337 fix)。
  const addonPlan = isStorageAddonPlanStr(t.storageAddonPlan) ? t.storageAddonPlan : 'standard';
  const limitBytes = computeStorageLimitBytes(addonPlan);
  const usedBytes = Number(t.storageBytesUsed);
  const usageRatio = limitBytes > 0 ? usedBytes / limitBytes : 0;

  return {
    id: t.id,
    tenantSeq: t.tenantSeq,
    slug: t.slug,
    name: t.name,
    plan: t.plan,
    createdAt: t.createdAt,
    activeUserCount,
    currentMonthApiCallCount: t.currentMonthApiCallCount,
    currentMonthApiCostJpy: t.currentMonthApiCostJpy,
    storageAddonPlan: addonPlan,
    storageBytesUsed: usedBytes,
    storageLimitBytes: limitBytes,
    storageUsageRatio: usageRatio,
  };
}

// ================================================================
// 2026-05-09 (PR E / #12 #14 #15): 外部サービス使用量 + Beginner 期限サマリ
// ================================================================

/**
 * Voyage AI 無料枠 (200M tokens / month) のしきい値。
 * 公式 (https://docs.voyageai.com/docs/pricing) に基づく voyage-4-lite の無料枠。
 * しきい値変更時は本定数を更新する。
 */
const VOYAGE_FREE_TIER_TOKENS_PER_MONTH = 200_000_000;

/**
 * Voyage AI 無料枠カードの返り値。
 *   - 当月累計の embedding token 数 (全テナント合算)
 *   - 200M 上限に対する利用率 (0.0-1.0+)
 *   - 'ok' / 'warn' (>=80%) / 'alert' (>=100%) のステータス
 */
export type VoyageUsageSummary = {
  currentMonthTokens: number;
  freeTierTokens: number;
  utilizationRatio: number;
  status: 'ok' | 'warn' | 'alert';
};

/**
 * Anthropic API 使用量カードの返り値。
 *   - 当月累計の input/output トークン
 *   - 当月累計の API 呼び出し回数 (auto-tag-extract + suggestion-explanation)
 *   - 当月累計の内部請求額 (= プラン別固定単価。Anthropic 実コストとは別系統 — Q5 参照)
 */
export type AnthropicUsageSummary = {
  currentMonthInputTokens: number;
  currentMonthOutputTokens: number;
  currentMonthCallCount: number;
  currentMonthInternalCostJpy: number;
};

/**
 * Beginner プラン使用状況サマリ。
 *   - Beginner プラン契約中のテナント件数
 *   - 期限切迫 (warning_60 / warning_75 / expired) のテナント件数
 *   - 当月の Beginner プラン総 API 呼び出し回数 (= 100 回/テナント上限の使用状況)
 */
export type BeginnerUsageSummary = {
  totalTenants: number;
  warning60Count: number;
  warning75Count: number;
  expiredCount: number;
  totalCurrentMonthCalls: number;
};

/**
 * 2026-05-09 (PR E): 当月初 (UTC 1 日 00:00) を返す。月初リセット cron と整合。
 */
function getCurrentMonthStartUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
}

/**
 * 2026-05-09 (PR E / #12): Voyage AI 当月使用量を集計。
 *   embedding 系の ApiCallLog (modelName = LLM_MODELS.EMBEDDING) を月初から集計。
 */
export async function getVoyageUsageSummary(): Promise<VoyageUsageSummary> {
  const monthStart = getCurrentMonthStartUtc();
  const result = await prisma.apiCallLog.aggregate({
    where: {
      createdAt: { gte: monthStart },
      // 2026-05-09 (PR E / #19): 管理テナント + default テナントを除外
      tenantId: { notIn: SUPER_ADMIN_EXCLUDED_TENANT_IDS },
      embeddingTokens: { not: null },
    },
    _sum: { embeddingTokens: true },
  });
  const currentMonthTokens = Number(result._sum.embeddingTokens ?? 0);
  const utilizationRatio = currentMonthTokens / VOYAGE_FREE_TIER_TOKENS_PER_MONTH;
  const status: VoyageUsageSummary['status'] =
    utilizationRatio >= 1.0 ? 'alert' : utilizationRatio >= 0.8 ? 'warn' : 'ok';
  return {
    currentMonthTokens,
    freeTierTokens: VOYAGE_FREE_TIER_TOKENS_PER_MONTH,
    utilizationRatio,
    status,
  };
}

/**
 * 2026-05-09 (PR E / #14): Anthropic 当月使用量を集計。
 *   LLM 系の ApiCallLog (llmInputTokens / llmOutputTokens) を月初から集計。
 */
export async function getAnthropicUsageSummary(): Promise<AnthropicUsageSummary> {
  const monthStart = getCurrentMonthStartUtc();
  const result = await prisma.apiCallLog.aggregate({
    where: {
      createdAt: { gte: monthStart },
      tenantId: { notIn: SUPER_ADMIN_EXCLUDED_TENANT_IDS },
      // LLM 呼び出しに限る (= input か output トークンのいずれかが記録されている)
      OR: [
        { llmInputTokens: { not: null } },
        { llmOutputTokens: { not: null } },
      ],
    },
    _sum: {
      llmInputTokens: true,
      llmOutputTokens: true,
      costJpy: true,
    },
    _count: { id: true },
  });
  return {
    currentMonthInputTokens: Number(result._sum.llmInputTokens ?? 0),
    currentMonthOutputTokens: Number(result._sum.llmOutputTokens ?? 0),
    currentMonthCallCount: result._count.id,
    currentMonthInternalCostJpy: result._sum.costJpy ?? 0,
  };
}

/**
 * 2026-05-09 (PR E / #15): Beginner プランのテナント別使用状況サマリ。
 *   beginnerExpiryState (active / warning_60 / warning_75 / expired) でカウントし、
 *   月次 API 呼出合計を返す。
 */
export async function getBeginnerUsageSummary(): Promise<BeginnerUsageSummary> {
  const tenants = await prisma.tenant.findMany({
    where: {
      id: { notIn: SUPER_ADMIN_EXCLUDED_TENANT_IDS },
      deletedAt: null,
      plan: 'beginner',
    },
    select: {
      createdAt: true,
      beginnerEverUpgraded: true,
      currentMonthApiCallCount: true,
    },
  });

  const { getBeginnerExpiryState } = await import('./beginner-expiry.service');
  let warning60 = 0;
  let warning75 = 0;
  let expired = 0;
  let totalCalls = 0;
  for (const t of tenants) {
    const state = getBeginnerExpiryState({
      plan: 'beginner',
      createdAt: t.createdAt,
      beginnerEverUpgraded: t.beginnerEverUpgraded,
    });
    if (state === 'warning_60') warning60 += 1;
    else if (state === 'warning_75') warning75 += 1;
    else if (state === 'expired') expired += 1;
    totalCalls += t.currentMonthApiCallCount;
  }

  return {
    totalTenants: tenants.length,
    warning60Count: warning60,
    warning75Count: warning75,
    expiredCount: expired,
    totalCurrentMonthCalls: totalCalls,
  };
}

/**
 * P-5b (2026-05-08): 過去 N ヶ月の月次使用量履歴を取得 (super_admin 履歴グラフ + CSV 用)。
 *
 * - tenant_monthly_usage_history からテナント x yearMonth で取得
 * - 管理テナントは元から保存されていないので除外不要 (snapshot 側で MANAGEMENT_TENANT_ID を弾いている)
 * - 並び: yearMonth 降順 (新しい月から) → tenantSeq 昇順
 *
 * 2026-05-14: 解約済テナント (tenant.deletedAt != null) の履歴行も取得する。
 *   `tenant.deletedAt` は join で取得して DTO に含め、CSV 上で「解約日」列として
 *   月途中解約の検知に使う。履歴クエリ自体は元々 tenant.deletedAt フィルタを
 *   していないため、変更は include 句のみ。
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
  /**
   * 2026-05-14: 親テナントの解約日 (null = アクティブ、Date = 解約済)。
   * 月途中解約された場合の請求対象期間判別に使用。
   */
  tenantDeletedAt: Date | null;
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

  // 2026-05-11: 顧客集計 (= 請求対象) のため、管理テナント + Default テナント (運営者自身)
  //   のスナップショットは除外。過去 PR で saveMonthlyUsageSnapshots が DEFAULT_TENANT_ID
  //   を含めて保存していた期間があり、本番 DB に Default の履歴行が残っている可能性に
  //   備えて防御的に query 層でも除外する (二重防御)。
  // 2026-05-14: include に tenant.deletedAt を追加し、解約日を CSV 列として返せるように。
  const rows = await prisma.tenantMonthlyUsageHistory.findMany({
    where: {
      yearMonth: { in: targetYearMonths },
      tenantId: { notIn: SUPER_ADMIN_EXCLUDED_TENANT_IDS },
    },
    orderBy: [{ yearMonth: 'desc' }, { tenantId: 'asc' }],
    include: {
      tenant: {
        select: { tenantSeq: true, name: true, deletedAt: true },
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
    // 2026-05-14: 親テナントの解約日 (請求対象期間判別用)
    tenantDeletedAt: r.tenant.deletedAt,
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

  // 顧客テナント全件 (管理テナント + default テナント + 削除済みは除外) + テナント内最新ログインを集計
  const tenants = await prisma.tenant.findMany({
    where: {
      // 2026-05-09 (PR E / #19): 管理テナント + default テナントを除外
      id: { notIn: SUPER_ADMIN_EXCLUDED_TENANT_IDS },
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
 * 解約時スナップショット (2026-05-14 追加):
 *   月途中解約された場合、6/1 以降の月次 cron `saveMonthlyUsageSnapshots` は
 *   `deletedAt: null` フィルタで該当テナントをスキップするため、当月分の利用料が
 *   `tenant_monthly_usage_history` に永久に記録されない問題があった。
 *   本関数は transaction 内で `tenantMonthlyUsageHistory.upsert` を行い、解約時点の
 *   `currentMonthApiCallCount` / `currentMonthApiCostJpy` を **当月の yearMonth** で確定保存する。
 *   - 解約後はその月の追加利用が発生しないため、解約時点の値 = 最終確定値
 *   - upsert により月次 cron との競合 (同月 yearMonth) も安全
 *   - 過去月 CSV エクスポート (listMonthlyUsageHistory) で取得可能になる
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
    select: {
      id: true,
      deletedAt: true,
      name: true,
      // 2026-05-14: 解約時スナップショット (TenantMonthlyUsageHistory upsert) 用
      plan: true,
      timezone: true,
      currentMonthApiCallCount: true,
      currentMonthApiCostJpy: true,
      storageAddonPlan: true,
      storageBytesUsed: true,
    },
  });
  if (!tenant) {
    throw new Error('TENANT_NOT_FOUND');
  }
  if (tenant.deletedAt != null) {
    throw new Error('ALREADY_DELETED');
  }

  const now = new Date();

  // 2026-05-14: 解約時スナップショット用にアクティブユーザ数を先に取得 (transaction 内で
  // user.updateMany が deletedAt をセットしてしまうと count が 0 になるため事前取得)。
  const activeUserCount = await prisma.user.count({
    where: { tenantId, isActive: true, deletedAt: null },
  });

  // 解約時の yearMonth スナップショットに使うアドオン情報を計算 (TZ 含めて)
  const rawAddonPlan = tenant.storageAddonPlan ?? 'standard';
  const storageAddonPlanSafe = isStorageAddonPlan(rawAddonPlan) ? rawAddonPlan : 'standard';
  const storageAddonJpy = SUPER_ADMIN_ADDON_MONTHLY_JPY[storageAddonPlanSafe];
  const totalJpy = tenant.currentMonthApiCostJpy + storageAddonJpy;
  const yearMonth = getTenantCurrentYearMonth(now, tenant.timezone);

  // 単一 transaction で一気に論理削除 (途中失敗で部分削除の不整合を避ける)
  // Tenant.update / auditLog.create / tenantMonthlyUsageHistory.upsert の戻り値は破棄。
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
    // 2026-05-14: 当月分の請求根拠を tenant_monthly_usage_history に確定保存。
    //   月次 cron saveMonthlyUsageSnapshots は deletedAt: null フィルタで弾くため、
    //   解約時にここで upsert しないと当月分が永久に履歴に残らない。
    //   既存行がある場合 (前回解約復活等の特殊ケース) は最新値で上書きする。
    prisma.tenantMonthlyUsageHistory.upsert({
      where: {
        tenantId_yearMonth: { tenantId, yearMonth },
      },
      create: {
        tenantId,
        yearMonth,
        apiCallCount: tenant.currentMonthApiCallCount,
        apiCostJpy: tenant.currentMonthApiCostJpy,
        plan: tenant.plan,
        activeUserCount,
        storageBytesUsed: tenant.storageBytesUsed,
        storageAddonPlan: storageAddonPlanSafe,
        storageAddonJpy,
        totalJpy,
      },
      update: {
        apiCallCount: tenant.currentMonthApiCallCount,
        apiCostJpy: tenant.currentMonthApiCostJpy,
        plan: tenant.plan,
        activeUserCount,
        storageBytesUsed: tenant.storageBytesUsed,
        storageAddonPlan: storageAddonPlanSafe,
        storageAddonJpy,
        totalJpy,
      },
    }),
    // 監査ログを残す (物理保持テーブルなので今後復元・監査が可能)
    // Phase 2-10: tenantId は削除対象テナント (= tenantId) を使う
    prisma.auditLog.create({
      data: {
        tenantId,
        userId: performerId,
        action: 'DELETE',
        entityType: 'tenant',
        entityId: tenantId,
        beforeValue: { name: tenant.name, deletedAt: null },
        afterValue: { name: tenant.name, deletedAt: now.toISOString() },
      },
    }),
  ]);

  // PR-V7 #1 (2026-05-19): Stripe Subscription キャンセル (= credit_card 払いテナントの引落停止)
  //
  // 設計判断:
  //   - **DB 削除 transaction の外側で実行**: Stripe API 失敗で DB 削除を巻き戻すと整合性問題が悪化する
  //     ため、DB 削除を最優先で確定 (= ユーザ可視の解約は完了) → Stripe API を best-effort で呼ぶ
  //   - **失敗時も throw しない**: 解約 API 全体としては成功扱いにし、Stripe 失敗は auditLog で残す
  //     (super_admin が auditLog 監視 + 必要なら Stripe Dashboard 手動キャンセル)
  //   - **isStripeEnabled() 早期 return**: 環境設定不備 / MVP 期間中の安全策
  //   - **MANAGEMENT_TENANT は最初の guard で reject 済**なのでここまで来ない
  if (isStripeEnabled()) {
    const cancelResult = await cancelTenantStripeSubscription(tenantId);
    if (!cancelResult.ok) {
      // Stripe API 失敗を auditLog に記録 (= super_admin 監査参照用)
      await prisma.auditLog.create({
        data: {
          tenantId,
          userId: performerId,
          action: 'DELETE',
          entityType: 'tenant',
          entityId: tenantId,
          afterValue: {
            stripeCancelFailed: true,
            errorCode: cancelResult.code,
            errorMessage: cancelResult.userMessage,
            severity: 'requires_manual_action',
            action: 'tenant_deleted_but_stripe_subscription_still_active',
          },
        },
      });
    }
  }

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
// テナント read-only 強制移行 (suspend / resume) — PR #372 / 2026-05-14
// ================================================================

/**
 * 停止理由コード。`Tenant.suspendReason` カラムに保存される文字列値。
 *
 * 将来 enum 化を検討するが v1 では String + 集合定数で運用 (Prisma 7 の enum 制約回避 +
 * 顧客向けメッセージで柔軟に切替えやすくするため)。
 */
export const SUSPEND_REASONS = [
  /** 支払い滞納 (= PAYMENT_DELINQUENCY_SOP §3 フェーズ 2 から実行) */
  'payment_delinquent',
  /** 利用規約違反 (TOS 違反による緊急停止) */
  'tos_violation',
  /** その他 (= 営業判断、運営内部事情等)。本番運用では極力使わず、上記いずれかに分類する */
  'other',
] as const;

export type SuspendReason = (typeof SUSPEND_REASONS)[number];

export function isSuspendReason(value: unknown): value is SuspendReason {
  return typeof value === 'string' && (SUSPEND_REASONS as readonly string[]).includes(value);
}

/**
 * テナント read-only 強制移行 (suspend) — PR #372 / 2026-05-14
 *
 * 役割:
 *   super_admin が支払い滞納 / TOS 違反等で対象テナントを **read-only モード** に強制移行する。
 *   write 系 HTTP method (POST/PATCH/PUT/DELETE) は middleware で 403 TENANT_SUSPENDED 遮断、
 *   GET 系 (閲覧・エクスポート) は引き続き可能。例外パス (self-delete / プラン変更) も従来通り通過。
 *
 * 処理内容 (単一 transaction):
 *   1. tenant.suspendedAt = now, suspendReason, suspendedBy = performerId をセット
 *   2. 配下の全 user (deletedAt=null) の tokenVersion を +1 increment
 *      → 既存セッションは次リクエストの getAuthenticatedUser で 401 SESSION_INVALIDATED となり
 *        再ログイン経路へ。再ログイン後の JWT には新 tenantSuspendedAt=ISO が乗り、以降の
 *        write 系 HTTP method は middleware で 403 遮断される。
 *   3. auditLog.create で「suspend」操作を記録
 *
 * 既に停止中のテナントへの再 suspend は ALREADY_SUSPENDED エラー (冪等性ではなく明示エラー)。
 * 削除済 (deletedAt!=null) テナントへの suspend は TENANT_DELETED エラー。
 *
 * 関連:
 *   - 解除: `resumeTenant`
 *   - 対外ルール: docs/business/PAYMENT_TERMS.md §2.3
 *   - 運用手順: docs/operations/PAYMENT_DELINQUENCY_SOP.md §3
 *   - middleware: src/lib/auth.config.ts (tenantSuspendedAt claim 判定)
 *   - JWT claim: src/lib/auth.ts (authorize の return に tenantSuspendedAt を含む)
 *
 * @param tenantId 停止対象テナント
 * @param reason 停止理由コード ([[SuspendReason]])
 * @param performerId 実行 super_admin の User.id (auditLog 記録 + tenant.suspendedBy)
 * @throws Error('MANAGEMENT_TENANT_FORBIDDEN') 管理テナントの停止は禁止
 * @throws Error('TENANT_NOT_FOUND') 対象テナント不在
 * @throws Error('TENANT_DELETED') 既に削除済テナント
 * @throws Error('ALREADY_SUSPENDED') 既に停止中
 * @throws Error('INVALID_REASON') 不正な reason 文字列
 */
export type SuspendTenantResult = {
  tenantId: string;
  suspendedAt: Date;
  suspendReason: SuspendReason;
  /** tokenVersion を増やしたユーザ件数 (= 即時セッション失効対象) */
  invalidatedSessionCount: number;
};

export async function suspendTenant(
  tenantId: string,
  reason: string,
  performerId: string,
): Promise<SuspendTenantResult> {
  if (tenantId === MANAGEMENT_TENANT_ID) {
    throw new Error('MANAGEMENT_TENANT_FORBIDDEN');
  }
  if (!isSuspendReason(reason)) {
    throw new Error('INVALID_REASON');
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, deletedAt: true, suspendedAt: true, name: true },
  });
  if (!tenant) {
    throw new Error('TENANT_NOT_FOUND');
  }
  if (tenant.deletedAt != null) {
    throw new Error('TENANT_DELETED');
  }
  if (tenant.suspendedAt != null) {
    throw new Error('ALREADY_SUSPENDED');
  }

  const now = new Date();

  // 単一 transaction で suspend + tokenVersion increment + auditLog を確定
  const [, tokenIncrement] = await prisma.$transaction([
    prisma.tenant.update({
      where: { id: tenantId },
      data: {
        suspendedAt: now,
        suspendReason: reason,
        suspendedBy: performerId,
        // resumedAt は前回解除時刻を保持 (=今回の suspend では更新しない)
      },
    }),
    // 配下 user の tokenVersion を全部 +1。 既存 JWT は次リクエストで 401。
    prisma.user.updateMany({
      where: { tenantId, deletedAt: null },
      data: { tokenVersion: { increment: 1 } },
    }),
    prisma.auditLog.create({
      data: {
        tenantId,
        userId: performerId,
        action: 'UPDATE',
        entityType: 'tenant',
        entityId: tenantId,
        beforeValue: { name: tenant.name, suspendedAt: null },
        afterValue: {
          name: tenant.name,
          suspendedAt: now.toISOString(),
          suspendReason: reason,
        },
      },
    }),
  ]);

  return {
    tenantId,
    suspendedAt: now,
    suspendReason: reason,
    invalidatedSessionCount: tokenIncrement.count,
  };
}

/**
 * テナント read-only 解除 (resume) — PR #372 / 2026-05-14
 *
 * 役割:
 *   入金確認 / 違反解消等で停止中テナントを通常運用へ復帰させる。
 *
 * 処理内容 (単一 transaction):
 *   1. tenant.suspendedAt = null, suspendReason = null, resumedAt = now をセット
 *      (suspendedBy は監査用に残す — 「直前に誰が停止したか」を resume 後も追跡可能にする)
 *   2. 配下の全 user の tokenVersion を +1 increment (再ログイン強制 → 新しい JWT claim 反映)
 *   3. auditLog.create で「resume」操作を記録
 *
 * 停止中でないテナントへの resume は NOT_SUSPENDED エラー (= 誤操作検知)。
 *
 * @throws Error('TENANT_NOT_FOUND')
 * @throws Error('TENANT_DELETED')
 * @throws Error('NOT_SUSPENDED') 停止中でないテナントへの resume
 */
export type ResumeTenantResult = {
  tenantId: string;
  resumedAt: Date;
  /** tokenVersion を増やしたユーザ件数 (= 即時セッション失効対象) */
  invalidatedSessionCount: number;
};

export async function resumeTenant(
  tenantId: string,
  performerId: string,
): Promise<ResumeTenantResult> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, deletedAt: true, suspendedAt: true, suspendReason: true, name: true },
  });
  if (!tenant) {
    throw new Error('TENANT_NOT_FOUND');
  }
  if (tenant.deletedAt != null) {
    throw new Error('TENANT_DELETED');
  }
  if (tenant.suspendedAt == null) {
    throw new Error('NOT_SUSPENDED');
  }

  const now = new Date();

  const [, tokenIncrement] = await prisma.$transaction([
    prisma.tenant.update({
      where: { id: tenantId },
      data: {
        suspendedAt: null,
        suspendReason: null,
        resumedAt: now,
        // suspendedBy は監査用に保持 (= 「直前に停止したのは誰か」を resume 後も追跡可能)
      },
    }),
    prisma.user.updateMany({
      where: { tenantId, deletedAt: null },
      data: { tokenVersion: { increment: 1 } },
    }),
    prisma.auditLog.create({
      data: {
        tenantId,
        userId: performerId,
        action: 'UPDATE',
        entityType: 'tenant',
        entityId: tenantId,
        beforeValue: {
          name: tenant.name,
          suspendedAt: tenant.suspendedAt.toISOString(),
          suspendReason: tenant.suspendReason,
        },
        afterValue: { name: tenant.name, suspendedAt: null, resumedAt: now.toISOString() },
      },
    }),
  ]);

  return {
    tenantId,
    resumedAt: now,
    invalidatedSessionCount: tokenIncrement.count,
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
 *   comments / attachments / tenant_import_preview / suggestion_explanations
 *
 * 保護対象 (= 物理削除しない):
 *   tenant 本体 (FK 整合性 + super_admin の監査参照)
 *   **users (2026-05-09 #18 で方針変更): Beginner プラン乱用防止のため永続保持**
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
 *   - **users は物理削除しない (2026-05-09 / #18 方針変更)**:
 *     旧仕様 (P-A) は GDPR 配慮で users を物理削除していたが、その後の方針判断により
 *     **Beginner プラン乱用防止** (= 解約 → Beginner 再契約の繰り返し回避) を優先するため、
 *     users 行は permanent に保持する。soft-delete 状態 (isActive=false / deletedAt=now)
 *     のままで、ログインは不可だが email + role は abuse-prevention check の根拠として残す。
 *     - tenant-onboarding.service.ts の `BEGINNER_NOT_AVAILABLE_FOR_RETURNING` 判定で参照
 *     - GDPR 等の個別削除請求は super_admin が手動で対応する運用 (cron 自動削除しない)
 *   - **冪等性**: 同一テナントの 2 回目以降は対象データが既に空なので no-op。
 *     失敗時はテナントごとに try/catch、cron 全体は止めない。
 *
 * 関連:
 *   - 計画: ユーザライフサイクルの Step 13 (テナント解約 → 90 日後物理削除)
 *   - 月初 cron: src/services/tenant-monthly-reset.service.ts (本関数を呼ぶ)
 *   - Beginner abuse 検知: src/services/tenant-onboarding.service.ts §previousDeletedTenants
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
      // 2026-05-09 (#18 方針変更): users を物理削除しない。
      //   Beginner プラン乱用防止のため、解約済テナントの users 行を永続保持する
      //   (soft-delete 状態のまま)。tenant-onboarding 側の abuse-prevention check は
      //   billingContactEmail を参照するため厳密には users 不要だが、将来 user.email
      //   ベースの判定に拡張する余地を残すため、ここで保護対象とする。
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
        // 2026-05-09 hotfix: SuggestionExplanation を project / customer の前で削除
        suggestionExplanations,
        projects,
        customers,
        importPreviews,
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
        // 2026-05-09 hotfix: SuggestionExplanation は project_id / tenant_id / generated_by の
        //   3 経路で FK を持つ。project / tenant の削除前に必ず明示削除する。
        prisma.suggestionExplanation.deleteMany({ where: { tenantId: t.id } }),
        prisma.project.deleteMany({ where: { tenantId: t.id } }),
        prisma.customer.deleteMany({ where: { tenantId: t.id } }),
        prisma.tenantImportPreview.deleteMany({ where: { tenantId: t.id } }),
        // 2026-05-09 (#18): users.deleteMany は意図的に削除しない (Beginner abuse 防止)
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
        // 2026-05-09 hotfix: SuggestionExplanation も合算
        suggestionExplanations.count +
        projects.count +
        customers.count +
        importPreviews.count;
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

// ================================================================
// 2026-05-11: Day 180 自動物理削除 — 期限切れ Beginner テナントの自動回収
// ================================================================

/**
 * Beginner プランで作成され、試用期間 (90日) を超えてもアップグレードされなかった
 * テナントを、作成から 180 日経過時点で自動的に物理削除する。
 *
 * 設計意図:
 *   - Day 0〜89:  Beginner 試用期間 (通常運用)
 *   - Day 90〜179: 読み取り専用モード (アップグレード or セルフ削除の猶予期間)
 *   - Day 180+:   本関数が物理削除を実行 (= データ容量の自動回収)
 *
 *   90 日の猶予期間はユーザが「アップグレードして救済」「データをエクスポートして退避」
 *   「セルフ削除で清算」のいずれかを選べる時間として確保される。期限切れ通知メール
 *   (beginner-expiry.service.ts) に「90 日後に自動削除」の旨が明記される。
 *
 * 対象条件:
 *   - plan = 'beginner'
 *   - beginnerEverUpgraded = false  (= 一度もアップグレード経験なし。経験ありは試用対象外なので 180 日縛りも対象外)
 *   - deletedAt = null              (= 既に手動セルフ削除 / super_admin 削除されていない)
 *   - createdAt < (now - 180 日)
 *   - id != MANAGEMENT_TENANT_ID    (= 管理テナントは絶対に削除しない)
 *
 * 動作:
 *   単一トランザクションで、業務データ群を物理削除 + tenant.deletedAt をセット (= 論理削除状態へ遷移)。
 *   users 行は **物理削除しない** (= purgeOldDeletedTenants と同方針。Beginner 乱用防止のため永続保持)。
 *   失敗は per-tenant try/catch で次回 cron へ retry を委ねる (= 1 件失敗が全体停止を引き起こさない)。
 *
 * 関連:
 *   - middleware (auth.config.ts): READ_ONLY_BYPASS_PATHS で「プラン変更」「セルフ削除」を許可。
 *     ユーザは Day 90 以降でも本関数による削除前にアップグレード or セルフ削除が可能。
 *   - 既存 purgeOldDeletedTenants: 手動 deleteTenant 後の grace 90 日対象 (本関数とはペア)。
 *   - cron: src/app/api/cron/daily-usage-aggregation/route.ts が本関数を呼ぶ (日次 02:00 UTC)。
 *   - 通知: beginner-expiry.service.ts の Day 90 メールで「90 日後に自動削除」を予告。
 */
export type PurgeExpiredBeginnerTenantsResult = {
  /** 物理削除を試行したテナント件数 */
  attempted: number;
  /** 成功した件数 */
  succeeded: number;
  /** 削除されたレコード総数 (業務データの sum) */
  totalRowsDeleted: number;
};

/**
 * 自動物理削除の対象となる「テナント作成からの日数」。
 *   - 90 日: 試用期間
 *   - + 90 日: 読み取り専用モード猶予 (= 救済期間)
 *   = 180 日合計
 */
export const BEGINNER_AUTO_DELETE_TOTAL_DAYS = 180;

export async function purgeExpiredBeginnerTenants(
  now: Date = new Date(),
): Promise<PurgeExpiredBeginnerTenantsResult> {
  const threshold = new Date(
    now.getTime() - BEGINNER_AUTO_DELETE_TOTAL_DAYS * 24 * 60 * 60 * 1000,
  );

  const targets = await prisma.tenant.findMany({
    where: {
      plan: 'beginner',
      beginnerEverUpgraded: false,
      deletedAt: null,
      createdAt: { lt: threshold },
      id: { not: MANAGEMENT_TENANT_ID },
    },
    select: { id: true },
  });

  let succeeded = 0;
  let totalRowsDeleted = 0;

  for (const t of targets) {
    try {
      // 単一 transaction で業務データ削除 + tenant 論理削除セットを実行。
      // 削除順序は purgeOldDeletedTenants と同一: 子テーブル → 親テーブル → tenant 本体。
      const [
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
        suggestionExplanations,
        projects,
        customers,
        importPreviews,
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
        prisma.suggestionExplanation.deleteMany({ where: { tenantId: t.id } }),
        prisma.project.deleteMany({ where: { tenantId: t.id } }),
        prisma.customer.deleteMany({ where: { tenantId: t.id } }),
        prisma.tenantImportPreview.deleteMany({ where: { tenantId: t.id } }),
        // テナント本体は deletedAt セット (= 物理削除しない。users とのペアで永続保持)。
        // user.isActive=false も同時に設定し、ログイン即時不可化 (deleteTenant と同パターン)。
        prisma.tenant.update({
          where: { id: t.id },
          data: { deletedAt: now },
        }),
        prisma.user.updateMany({
          where: { tenantId: t.id, deletedAt: null },
          data: { deletedAt: now, isActive: false },
        }),
      ]);

      // PR-V7 横展開 (2026-05-19): #1 と同じく Stripe Subscription 自動キャンセル。
      //   Beginner ダウングレード禁止のため通常は credit_card 持ちの Beginner は存在しないが、
      //   旧データ / 手動操作で生じた場合の defense in depth として cancel を試みる。
      //   helper は `no_subscription` を no-op で返すので呼出コストは無害。
      if (isStripeEnabled()) {
        const cancelResult = await cancelTenantStripeSubscription(t.id);
        if (!cancelResult.ok) {
          await prisma.auditLog.create({
            data: {
              tenantId: t.id,
              userId: t.id, // cron 実行 (system 相当)、entityId と同じ
              action: 'DELETE',
              entityType: 'tenant',
              entityId: t.id,
              afterValue: {
                stripeCancelFailed: true,
                errorCode: cancelResult.code,
                errorMessage: cancelResult.userMessage,
                severity: 'requires_manual_action',
                action: 'beginner_auto_purge_stripe_cancel_failed',
              },
            },
          });
        }
      }

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
        suggestionExplanations.count +
        projects.count +
        customers.count +
        importPreviews.count;
      totalRowsDeleted += subTotal;
      succeeded += 1;
    } catch {
      // 1 テナント失敗で他に影響させない (次回 cron で retry)
    }
  }

  return {
    attempted: targets.length,
    succeeded,
    totalRowsDeleted,
  };
}
