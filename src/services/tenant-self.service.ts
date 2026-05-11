/**
 * テナント自己管理サービス (PR-X4 / 2026-05-07)
 *
 * 役割:
 *   テナント管理者 (admin role) が自テナントのプラン・予算上限を self-service で変更する。
 *   呼出側で systemRole === 'admin' を確認する前提。
 *
 * プラン変更ルール (V1_FINAL_TASKS.md §PR-X4):
 *   - アップグレード (Beginner → Expert / Pro、Expert → Pro): **即時反映**
 *   - ダウングレード (Pro → Expert / Beginner、Expert → Beginner): **翌月適用**
 *     (scheduledPlanChangeAt + scheduledNextPlan を設定、月初 cron で実反映)
 *   - Beginner ダウングレード時: 席数 ≤ 5 でないと拒否 (UI で事前警告 + API でも防御)
 *
 * 関連:
 *   - 計画: docs/roadmap/V1_FINAL_TASKS.md PR-X4
 *   - 月初 cron: scheduled_plan_change_at <= today に対して plan を scheduledNextPlan に更新
 */

import { prisma } from '@/lib/db';
import type { TenantPlan } from '@/lib/tenant';
import {
  getBeginnerExpiryState,
  getBeginnerDaysRemaining,
  type BeginnerExpiryState,
} from './beginner-expiry.service';

/** プランの強さ順序 (アップグレード判定用) */
const PLAN_ORDER: Record<TenantPlan, number> = {
  beginner: 0,
  expert: 1,
  pro: 2,
};

function isUpgrade(current: TenantPlan, next: TenantPlan): boolean {
  return PLAN_ORDER[next] > PLAN_ORDER[current];
}

export type TenantSelfInfo = {
  id: string;
  tenantSeq: number | null;
  name: string;
  plan: TenantPlan;
  monthlyBudgetCapJpy: number | null;
  beginnerMaxSeats: number;
  beginnerMonthlyCallLimit: number;
  currentMonthApiCallCount: number;
  currentMonthApiCostJpy: number;
  scheduledPlanChangeAt: Date | null;
  scheduledNextPlan: string | null;
  activeUserCount: number;
  // P-G (2026-05-08): 請求先情報 / PR C (2026-05-09 #5/#8/#10) で個人法人 + 住所構造化を追加
  billingType: string;
  billingCompanyName: string | null;
  billingContactName: string | null;
  billingContactEmail: string | null;
  /** Legacy: 旧 単一 Text 住所 (新規入力なし、構造化が NULL の時のみ表示フォールバック) */
  billingAddress: string | null;
  billingPostalCode: string | null;
  billingPrefecture: string | null;
  billingCity: string | null;
  billingStreetAddress: string | null;
  billingBuildingName: string | null;
  billingPhoneNumber: string | null;
  paymentMethod: string;
  // P-B (2026-05-08): Beginner プラン期限ステータス (画面のバナー表示用)
  beginnerExpiryState: BeginnerExpiryState;
  /** Beginner プランの残り日数。plan != beginner なら null */
  beginnerDaysRemaining: number | null;
  // 2026-05-09 (PR G / #24): シードデータ参照 toggle
  seedDataEnabled: boolean;
  // PR-1 (2026-05-15): テナント単位の TZ / locale (旧 User.timezone/locale の集約先)
  timezone: string;
  locale: string;
};

/**
 * 自テナント情報の取得 (テナント管理者画面用)。
 */
export async function getTenantSelfInfo(tenantId: string): Promise<TenantSelfInfo | null> {
  const t = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
  });
  if (!t) return null;

  const activeUserCount = await prisma.user.count({
    where: { tenantId, isActive: true, deletedAt: null },
  });

  // P-B (2026-05-08): Beginner プラン期限の判定 (純関数なので副作用なし)
  const expiryInput = {
    plan: t.plan,
    createdAt: t.createdAt,
    beginnerEverUpgraded: t.beginnerEverUpgraded,
  };
  const beginnerExpiryState = getBeginnerExpiryState(expiryInput);
  const beginnerDaysRemaining = getBeginnerDaysRemaining(expiryInput);

  return {
    id: t.id,
    tenantSeq: t.tenantSeq,
    name: t.name,
    plan: t.plan as TenantPlan,
    monthlyBudgetCapJpy: t.monthlyBudgetCapJpy,
    beginnerMaxSeats: t.beginnerMaxSeats,
    beginnerMonthlyCallLimit: t.beginnerMonthlyCallLimit,
    currentMonthApiCallCount: t.currentMonthApiCallCount,
    currentMonthApiCostJpy: t.currentMonthApiCostJpy,
    scheduledPlanChangeAt: t.scheduledPlanChangeAt,
    scheduledNextPlan: t.scheduledNextPlan,
    activeUserCount,
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
    beginnerExpiryState,
    beginnerDaysRemaining,
    seedDataEnabled: t.seedDataEnabled,
    // PR-1 (2026-05-15): テナント単位 TZ / locale
    timezone: t.timezone,
    locale: t.locale,
  };
}

/**
 * PR-1 (2026-05-15): テナント i18n 設定 (timezone / locale) を更新する。
 *
 * - 旧 User.timezone / User.locale を Tenant に集約。テナント管理者のみ更新可。
 * - 値の検証は呼出側 (zod) で実施 (IANA TZ / SELECTABLE_LOCALES のみ受理)。
 * - 同一テナント内の全ユーザが同じ TZ/locale で運用される。
 *
 * @returns 更新後の値
 */
export async function updateTenantI18n(
  tenantId: string,
  input: { timezone?: string; locale?: string },
): Promise<{ timezone: string; locale: string }> {
  const data: Record<string, string> = {};
  if (typeof input.timezone === 'string' && input.timezone.length > 0) {
    data.timezone = input.timezone;
  }
  if (typeof input.locale === 'string' && input.locale.length > 0) {
    data.locale = input.locale;
  }

  if (Object.keys(data).length === 0) {
    // no-op: 現在値を返す (UI 側で state 同期するため、空送信もエラーにしない)
    const t = await prisma.tenant.findFirstOrThrow({
      where: { id: tenantId, deletedAt: null },
      select: { timezone: true, locale: true },
    });
    return { timezone: t.timezone, locale: t.locale };
  }

  const updated = await prisma.tenant.update({
    where: { id: tenantId },
    data,
    select: { timezone: true, locale: true },
  });
  return { timezone: updated.timezone, locale: updated.locale };
}

/** P-G (2026-05-08): 請求先情報の更新入力 / PR C (2026-05-09 #5/#8/#10) 拡張 */
export type UpdateBillingContactInput = {
  billingType?: 'corporate' | 'individual';
  billingCompanyName?: string | null;
  billingContactName?: string | null;
  billingContactEmail?: string | null;
  billingPostalCode?: string | null;
  billingPrefecture?: string | null;
  billingCity?: string | null;
  billingStreetAddress?: string | null;
  billingBuildingName?: string | null;
  billingPhoneNumber?: string | null;
  paymentMethod?: string;
};

/**
 * 請求先情報のみを更新する (テナント管理者画面の「請求先情報」セクション用)。
 *
 * - 各フィールドは optional: undefined なら変更なし、null なら値クリア
 * - paymentMethod は文字列だが、UI 側で enum (invoice / bank_transfer / credit_card) を強制
 *
 * 2026-05-09 (PR C / #5): billingType='individual' に切替時は会社名を自動 null クリアする
 *   (UI で会社名フィールドが非表示になるが過去入力データを残さないようサーバ側でも保証)。
 *
 * 設計判断: updateTenantSelf (プラン変更) と分離。プラン変更ロジックは複雑 (即時/翌月予約) で、
 * 請求先情報の単純な update と一緒にすると条件分岐が散漫になるため、別関数化。
 */
export async function updateBillingContact(
  tenantId: string,
  input: UpdateBillingContactInput,
): Promise<void> {
  const data: Record<string, unknown> = {};
  if (input.billingType !== undefined) {
    data.billingType = input.billingType;
    // 2026-05-09 (PR C / #5): individual 切替時は会社名を null クリア。
    //   client が billingCompanyName を渡さない / null で渡してくる前提だが、defense-in-depth。
    if (input.billingType === 'individual') {
      data.billingCompanyName = null;
    }
  }
  if (input.billingCompanyName !== undefined) data.billingCompanyName = input.billingCompanyName;
  if (input.billingContactName !== undefined) data.billingContactName = input.billingContactName;
  if (input.billingContactEmail !== undefined) data.billingContactEmail = input.billingContactEmail;
  // 2026-05-09 (PR C / #8): 住所構造化フィールド。
  if (input.billingPostalCode !== undefined) data.billingPostalCode = input.billingPostalCode;
  if (input.billingPrefecture !== undefined) data.billingPrefecture = input.billingPrefecture;
  if (input.billingCity !== undefined) data.billingCity = input.billingCity;
  if (input.billingStreetAddress !== undefined) data.billingStreetAddress = input.billingStreetAddress;
  if (input.billingBuildingName !== undefined) data.billingBuildingName = input.billingBuildingName;
  if (input.billingPhoneNumber !== undefined) data.billingPhoneNumber = input.billingPhoneNumber;
  if (input.paymentMethod !== undefined) data.paymentMethod = input.paymentMethod;

  if (Object.keys(data).length === 0) return; // 何も指定がなければ noop

  await prisma.tenant.update({
    where: { id: tenantId },
    data,
  });
}

export type UpdateTenantSelfInput = {
  /** 変更先プラン (省略時は変更なし)。 */
  plan?: TenantPlan;
  /** 月次予算上限。null = 無制限、undefined = 変更なし */
  monthlyBudgetCapJpy?: number | null;
  // 2026-05-09 (PR G / #24): シードデータ参照 toggle (即時反映)
  seedDataEnabled?: boolean;
};

export type UpdateTenantSelfResult =
  | { ok: true; appliedImmediately: boolean; scheduledFor: Date | null }
  | {
      ok: false;
      error:
        | 'BEGINNER_REQUIRES_FEWER_SEATS'
        | 'INVALID_BUDGET'
        // P-B (2026-05-08): 上位プラン → Beginner ダウングレードは禁止
        | 'BEGINNER_DOWNGRADE_FORBIDDEN'
        // PR-2 (2026-05-15): Beginner プランは月次予算上限 (金額) を設定できない (=固定の月 100 回上限)。
        //   UI でフォーム自体は非表示だが、API 直叩きの迂回防止として明示的に拒否する。
        | 'BEGINNER_BUDGET_NOT_ALLOWED';
    };

/**
 * 自テナントのプラン / 予算上限を更新する。
 *
 * - プラン アップグレード時: 即時反映 (plan を直接更新)
 * - プラン ダウングレード時: scheduledPlanChangeAt + scheduledNextPlan を翌月 1 日に設定
 * - Beginner ダウングレード時: 席数 ≤ 5 でなければエラー
 * - 予算上限: 即時反映 (non-negative or null)
 */
export async function updateTenantSelf(
  tenantId: string,
  input: UpdateTenantSelfInput,
): Promise<UpdateTenantSelfResult> {
  // 入力バリデーション
  if (
    input.monthlyBudgetCapJpy !== undefined &&
    input.monthlyBudgetCapJpy !== null &&
    input.monthlyBudgetCapJpy < 0
  ) {
    return { ok: false, error: 'INVALID_BUDGET' };
  }

  const tenant = await prisma.tenant.findFirstOrThrow({
    where: { id: tenantId, deletedAt: null },
  });

  // PR-2 (2026-05-15): Beginner プランの最終 plan で予算上限 (= 非 null 値) を設定しようとしたら拒否。
  //   ここでの「最終 plan」= 変更後 plan が指定されていればそれ、なければ現プラン。
  //   - 既存テナントが Beginner: 予算更新リクエスト拒否
  //   - 同一プラン (Beginner → Beginner) で予算更新: 拒否
  //   - プラン変更なし + 予算 null 化 (= 明示的にクリア): 許可 (Beginner で残値クリアの救済)
  const targetPlan: TenantPlan = (input.plan ?? tenant.plan) as TenantPlan;
  if (
    targetPlan === 'beginner' &&
    input.monthlyBudgetCapJpy !== undefined &&
    input.monthlyBudgetCapJpy !== null
  ) {
    return { ok: false, error: 'BEGINNER_BUDGET_NOT_ALLOWED' };
  }

  // 予算上限 / seedDataEnabled のみの変更 (プランは変えない)
  if (input.plan === undefined) {
    const data: Record<string, unknown> = {};
    if (input.monthlyBudgetCapJpy !== undefined) data.monthlyBudgetCapJpy = input.monthlyBudgetCapJpy;
    // 2026-05-09 (PR G / #24): seedDataEnabled toggle (即時反映)
    if (input.seedDataEnabled !== undefined) data.seedDataEnabled = input.seedDataEnabled;
    if (Object.keys(data).length > 0) {
      await prisma.tenant.update({ where: { id: tenantId }, data });
    }
    return { ok: true, appliedImmediately: true, scheduledFor: null };
  }

  const currentPlan = tenant.plan as TenantPlan;
  const nextPlan = input.plan;

  // 同一プランへの変更はノーオペ (ただし予算上限は更新可能)
  if (currentPlan === nextPlan) {
    if (input.monthlyBudgetCapJpy !== undefined) {
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { monthlyBudgetCapJpy: input.monthlyBudgetCapJpy },
      });
    }
    return { ok: true, appliedImmediately: true, scheduledFor: null };
  }

  if (isUpgrade(currentPlan, nextPlan)) {
    // アップグレード: 即時反映 + 予約をクリア + beginnerEverUpgraded フラグ立て
    // P-B (2026-05-08): beginnerEverUpgraded=true にすることで、以後ダウングレード予約や
    //   再アップグレードでも「Beginner 試用期間」の対象から外れる (Beginner に戻せない方針)。
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        plan: nextPlan,
        scheduledPlanChangeAt: null,
        scheduledNextPlan: null,
        beginnerEverUpgraded: true,
        ...(input.monthlyBudgetCapJpy !== undefined
          ? { monthlyBudgetCapJpy: input.monthlyBudgetCapJpy }
          : {}),
      },
    });
    return { ok: true, appliedImmediately: true, scheduledFor: null };
  }

  // P-B (2026-05-08): Beginner ダウングレード禁止 (Expert/Pro → Beginner は不可)。
  //   Beginner プランは「初回テナント作成から 90 日限定の試用」のため、上位プランに
  //   一度上がったテナントは戻せない仕様。Expert ↔ Pro 間のダウングレードは引き続き可。
  if (nextPlan === 'beginner') {
    return { ok: false, error: 'BEGINNER_DOWNGRADE_FORBIDDEN' };
  }

  // 翌月 1 日 (UTC) に予約
  const now = new Date();
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      scheduledPlanChangeAt: nextMonthStart,
      scheduledNextPlan: nextPlan,
      ...(input.monthlyBudgetCapJpy !== undefined
        ? { monthlyBudgetCapJpy: input.monthlyBudgetCapJpy }
        : {}),
    },
  });

  return { ok: true, appliedImmediately: false, scheduledFor: nextMonthStart };
}

/**
 * ダウングレード予約をキャンセルする。
 */
export async function cancelScheduledPlanChange(tenantId: string): Promise<void> {
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      scheduledPlanChangeAt: null,
      scheduledNextPlan: null,
    },
  });
}
