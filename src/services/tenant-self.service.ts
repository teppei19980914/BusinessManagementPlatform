/**
 * テナント自己管理サービス (PR-X4 / 2026-05-07)
 *
 * 役割:
 *   テナント管理者 (admin role) が自テナントのプラン・予算上限を self-service で変更する。
 *   呼出側で systemRole === 'admin' を確認する前提。
 *
 * プラン変更ルール:
 *   - アップグレード (Beginner → Expert / Pro、Expert → Pro): **即時反映**
 *   - **Expert ↔ Pro 切替 (上下方向問わず): 即時反映** (2026-05-14 修正)
 *     - 当月分の従量課金は per-call 単価で個別記録されるため、月途中の即時切替でも
 *       課金整合性が保たれる (切替前 ¥5 / 切替後 ¥15 が ApiCallLog に正しく記録される、2026-05-15 改定後)。
 *     - 業務仕様書 (docs/business/TENANT_AND_BILLING.md §F-13.11) が当初から
 *       「Expert ↔ Pro の切替は即時反映」を要求しており、本ファイルの実装が
 *       過剰に保守的だったのを修正。
 *   - **Beginner ダウングレード**: BEGINNER_DOWNGRADE_FORBIDDEN で **完全拒否** (P-B)
 *     - 上位プランから Beginner には戻せない (Beginner は初回 90 日試用限定のため)。
 *     - 旧仕様では「翌月予約」だったが、P-B (2026-05-08) で完全禁止に変更。
 *   - Beginner ダウングレード時: 席数 ≤ 5 でないと拒否 (Beginner 移行自体が禁止なので
 *     現状は到達不能ガード。将来 P-B が緩和された場合の防御線として残置)
 *
 * 予約 (scheduled*) フィールドの扱い:
 *   - 現仕様では `scheduledPlanChangeAt` / `scheduledNextPlan` を新規にセットする
 *     コードパスは存在しない (Expert↔Pro 即時化 + Beginner downgrade 禁止のため)。
 *   - ただし旧 DB レコードに残った予約や、将来 Beginner downgrade 緩和時のために
 *     月初 cron 側 (tenant-monthly-reset.service.ts) の適用ロジックと
 *     `cancelScheduledPlanChange` は引き続き残す。
 *
 * 関連:
 *   - 計画: docs/roadmap/V1_FINAL_TASKS.md PR-X4
 *   - 業務仕様: docs/business/TENANT_AND_BILLING.md §F-13.11 / §NF-13.15
 *   - 月初 cron: scheduled_plan_change_at <= today に対して plan を scheduledNextPlan に更新
 */

import { prisma } from '@/lib/db';
import type { TenantPlan } from '@/lib/tenant';
// PR-V8.2 (2026-05-19) ★請求 invariant★: getTenantSelfInfo を ApiCallLog SUM 真値で返却
import { reconcileTenantApiUsage } from './api-usage-recalc.service';
import {
  getBeginnerExpiryState,
  getBeginnerDaysRemaining,
  type BeginnerExpiryState,
} from './beginner-expiry.service';
// PR-S3 (2026-05-14): Stripe 連携 — プラン変更時のカード検証
// PR-V7 #3 (2026-05-19): credit_card → invoice 戻し時の Stripe Subscription キャンセル
import { isStripeEnabled } from '@/lib/stripe';
import {
  verifyTenantCard,
  cancelTenantStripeSubscription,
} from './stripe-billing.service';

// 2026-05-14: PLAN_ORDER / isUpgrade / getTenantNextMonthStart は撤去。
//   全プラン変更を即時反映に統一したため、アップグレード/ダウングレードを区別する必要が
//   無くなった (Beginner ダウングレードのみ事前拒否、それ以外は一律即時)。
//   旧予約適用ロジック (月初 cron 側) は legacy DB レコード対策として
//   tenant-monthly-reset.service.ts に残置。

export type TenantSelfInfo = {
  id: string;
  /** Tenant.slug (= 組織 ID)。ログイン画面の「組織 ID」入力欄に対応。
   *  管理者がユーザに伝える正規の識別子として、設定画面で独立ラベル表示する (2026-05-21)。 */
  slug: string;
  tenantSeq: number | null;
  name: string;
  /** テナント作成日時 (運用期間把握 + Beginner 期限の起点)。 */
  createdAt: Date;
  /** プラン別の per-call 単価 (円整数)。2026-05-15 改定: Haiku ¥5 / Sonnet ¥15。 */
  pricePerCallHaiku: number;
  pricePerCallSonnet: number;
  /** テナント停止状態 (= read-only モード)。null = 通常運用。 */
  suspendedAt: Date | null;
  /** 停止理由コード ('payment_delinquent' / 'tos_violation' / 'other' 等)。 */
  suspendReason: string | null;
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
  // PR-S5 (2026-05-14): Stripe 連携情報 (admin 画面の「支払い方法」セクション表示用)。
  //   credit_card 払いでない場合は全 null。
  /** Stripe Customer ID (= テナントが Stripe に作成した顧客 ID) */
  stripeCustomerId: string | null;
  /** Stripe Subscription 状態 ('active' / 'past_due' / 'canceled' / 'incomplete' 等) */
  stripeSubscriptionStatus: string | null;
  /** Default Payment Method ID (= デフォルト引落カード) */
  stripeDefaultPaymentMethodId: string | null;
  /** カード検証状態 ('valid' / 'expired' / 'declined' / 'never_verified') */
  cardVerificationStatus: string | null;
  /** 直近のカード検証成功時刻 */
  cardLastVerifiedAt: Date | null;
  /** Smart Retries 全失敗後の自動 suspend 予定時刻 */
  autoSuspendScheduledAt: Date | null;
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

  // ★ PR-V8.2 (2026-05-19) 請求 invariant: 関数返却値も ApiCallLog SUM (真値) ベースに統一。
  //   旧実装は counter (Tenant.currentMonthApi*) をそのまま返していたため、UI 側で別途
  //   reconcile を被せる必要があった。/api/tenants/me GET レスポンスや /admin/users page 等で
  //   counter 値が露出する設計欠陥になっていたため、関数内で reconcile して真値で返す。
  //   reconcile が null (= 不在 / 集計失敗) のときのみ counter にフォールバック。
  const reconcile = await reconcileTenantApiUsage(tenantId).catch(() => null);

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
    slug: t.slug,
    tenantSeq: t.tenantSeq,
    name: t.name,
    createdAt: t.createdAt,
    pricePerCallHaiku: t.pricePerCallHaiku,
    pricePerCallSonnet: t.pricePerCallSonnet,
    suspendedAt: t.suspendedAt,
    suspendReason: t.suspendReason,
    plan: t.plan as TenantPlan,
    monthlyBudgetCapJpy: t.monthlyBudgetCapJpy,
    beginnerMaxSeats: t.beginnerMaxSeats,
    beginnerMonthlyCallLimit: t.beginnerMonthlyCallLimit,
    // ★ PR-V8.2: ApiCallLog SUM (真値) を優先。counter フォールバックは reconcile null のみ。
    currentMonthApiCallCount: reconcile?.reconciledCallCount ?? t.currentMonthApiCallCount,
    currentMonthApiCostJpy: reconcile?.reconciledCostJpy ?? t.currentMonthApiCostJpy,
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
    // PR-S5 (2026-05-14): Stripe 連携情報 (= UI 「支払い方法」セクション表示用)
    stripeCustomerId: t.stripeCustomerId,
    stripeSubscriptionStatus: t.stripeSubscriptionStatus,
    stripeDefaultPaymentMethodId: t.stripeDefaultPaymentMethodId,
    cardVerificationStatus: t.cardVerificationStatus,
    cardLastVerifiedAt: t.cardLastVerifiedAt,
    autoSuspendScheduledAt: t.autoSuspendScheduledAt,
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
 * - paymentMethod は文字列だが、UI 側で enum (invoice / credit_card) を強制
 *   (旧 'bank_transfer' は 'invoice' に統合済 2026-05-15。UI ラベル「銀行振込」, 内部値 'invoice')
 *
 * 2026-05-09 (PR C / #5): billingType='individual' に切替時は会社名を自動 null クリアする
 *   (UI で会社名フィールドが非表示になるが過去入力データを残さないようサーバ側でも保証)。
 *
 * **PR-V7 #3 (2026-05-19): credit_card → invoice 戻し時の Stripe Subscription キャンセル**
 *   仕様: docs/specification/STRIPE_PAYMENT_UI.md §2.3 + STRIPE_BILLING.md §C-1
 *   credit_card 払いから invoice 戻しを行うと、Stripe Subscription はそのまま active のままだと
 *   Storage add-on の固定費が二重に引落される (Stripe 引落 + 運営手動 invoice)。これを防ぐため、
 *   paymentMethod 遷移 credit_card → invoice を検出したら Stripe Subscription を即時キャンセル。
 *   キャンセル失敗時は auditLog に記録し super_admin に運用対応を促す。
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

  // PR-V7 #3: paymentMethod 遷移 (credit_card → invoice) を事前検知するため現在値を取得
  let stripeCancelNeeded = false;
  if (input.paymentMethod !== undefined && input.paymentMethod !== 'credit_card') {
    const current = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { paymentMethod: true, stripeSubscriptionId: true },
    });
    if (
      current?.paymentMethod === 'credit_card' &&
      current.stripeSubscriptionId != null
    ) {
      stripeCancelNeeded = true;
    }
  }

  await prisma.tenant.update({
    where: { id: tenantId },
    data,
  });

  // PR-V7 #3: DB 更新成功後に Stripe Subscription をキャンセル (= best-effort)
  //   失敗時は auditLog に記録 → super_admin が Stripe Dashboard で手動対応する運用
  if (stripeCancelNeeded && isStripeEnabled()) {
    const result = await cancelTenantStripeSubscription(tenantId);
    if (!result.ok) {
      await prisma.auditLog.create({
        data: {
          tenantId,
          // updateBillingContact は呼出側 user 情報を持たないため、エンティティとしての操作主体不明。
          //   API route 経由なので呼出 user は存在するが本 service は user 引数を取らない設計。
          //   audit log 用に system user 相当の UUID をフォールバック ('00000000-...' ではなく
          //   呼出側 route で audit を残すべきだが、ここでも 1 件残して二重防御)。
          userId: tenantId, // entity 主体相当、tenantId を流用
          action: 'UPDATE',
          entityType: 'tenant',
          entityId: tenantId,
          afterValue: {
            stripeCancelFailed: true,
            transition: 'credit_card_to_invoice',
            errorCode: result.code,
            errorMessage: result.userMessage,
            severity: 'requires_manual_action',
            action: 'paymentMethod_reverted_but_stripe_subscription_still_active',
          },
        },
      });
    }
  }
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
    }
  // PR-S3 (2026-05-14): credit_card 払いテナントのプラン変更時カード検証失敗
  | {
      ok: false;
      error: 'CARD_VERIFICATION_FAILED';
      cardStatus: 'expired' | 'declined';
      failureReason?: string;
    };

/**
 * 自テナントのプラン / 予算上限を更新する。
 *
 * - プラン アップグレード: 即時反映 (plan を直接更新)
 * - **Expert ↔ Pro 切替 (上下双方向): 即時反映** (2026-05-14)
 *   - per-call 課金は呼出時点の plan で単価が決まるため、月途中の切替でも整合する
 * - Beginner ダウングレード: BEGINNER_DOWNGRADE_FORBIDDEN で拒否 (P-B)
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

  // P-B (2026-05-08): Beginner ダウングレード禁止 (Expert/Pro → Beginner は不可)。
  //   Beginner プランは「初回テナント作成から 90 日限定の試用」のため、上位プランに
  //   一度上がったテナントは戻せない仕様。
  //   2026-05-14: 旧予約パスを廃止 (= ダウングレードを一律即時反映化) したため、
  //   本ガードは「ダウングレードの中で Beginner だけは禁止」を表す唯一の入口になった。
  if (nextPlan === 'beginner') {
    return { ok: false, error: 'BEGINNER_DOWNGRADE_FORBIDDEN' };
  }

  // PR-S3 (2026-05-14): credit_card 払いテナントはプラン変更前にカードを検証する。
  //   詳細設計 §4.4 (= ユーザ確定の追加要件): 「プラン変更時、再度クレジットカード情報が
  //   誤っていないか、請求ができるかを確認する」
  //   - paymentMethod === 'credit_card' のときのみ実行
  //   - feature flag STRIPE_ENABLED=true の時のみ実行 (= 未有効化環境では skip)
  //   - 検証失敗時はプラン変更を拒否、顧客に Stripe ポータルでのカード更新を促す
  if (tenant.paymentMethod === 'credit_card' && isStripeEnabled()) {
    const verifyResult = await verifyTenantCard(tenantId);
    if (!verifyResult.ok) {
      // Stripe API 一時障害等 → プラン変更を遮断して再試行を促す (= 課金リスク回避)
      return {
        ok: false,
        error: 'CARD_VERIFICATION_FAILED',
        cardStatus: 'declined',
        failureReason: 'verification_unavailable',
      };
    }
    if (verifyResult.value.status !== 'valid') {
      return {
        ok: false,
        error: 'CARD_VERIFICATION_FAILED',
        cardStatus: verifyResult.value.status as 'expired' | 'declined',
        failureReason: verifyResult.value.failureReason,
      };
    }
  }

  // 2026-05-14: 全プラン変更を即時反映に統一。
  //   - アップグレード (Beginner→Expert/Pro、Expert→Pro): 従来通り即時
  //   - Expert ↔ Pro ダウングレード: 業務仕様 §F-13.11 に従い即時反映に変更
  //     (旧実装は scheduledPlanChangeAt + 翌月 cron 適用だったが、per-call 課金モデルでは
  //      月途中切替でも当月分課金が正しく分離されるため遅延の必要なし)
  // beginnerEverUpgraded=true により、以後 Beginner 試用期間の対象から外れる。
  // 旧予約 (DB に残存する `scheduledPlanChangeAt`) は強制クリアする
  // (アップグレード/Expert↔Pro 変更を契機に予約をリセットするのは旧実装と同じ挙動)。
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
