/**
 * Stripe Metered Billing 連携サービス層 (PR-S2 / 2026-05-14)
 *
 * 役割:
 *   Stripe SDK の薄いラッパー + DB との整合性確保。API route / Webhook ハンドラ / cron から呼ばれる。
 *
 * 主要関数:
 *   - createOrGetStripeCustomer(tenantId): Stripe Customer を取得 or 新規作成 (idempotent)
 *   - createCheckoutSessionForCardSetup(tenantId, returnUrl): カード登録用 Checkout Session 作成
 *   - createCustomerPortalSession(tenantId, returnUrl): Customer Portal Session 作成
 *   - verifyTenantCard(tenantId): カード期限 + 検証用 SetupIntent で「請求可能か」確認
 *   - createSubscriptionForTenant(tenantId, billingCycleAnchor): Subscription 作成 (= プラン契約)
 *   - reportUsage(tenantId, callType, apiCallLogId, quantity, occurredAt): Usage Record 送信
 *
 * 設計方針 (詳細設計 §A-1, §A-2):
 *   - **idempotency_key 必須**: 全 Stripe API 呼出に idempotency_key を付与 (= 重複作成防止)
 *   - **DB 先行 + Stripe 後追い**: setup フローは Phase 1-4 に分割 (詳細設計 §A-1 参照)
 *   - **エラーは Result 型で返却**: withStripeError でラップし、呼出側でハンドリング
 *   - **feature flag は呼出側でチェック**: 本サービスは isStripeEnabled() のチェックをしない
 *     (= 呼出側で feature flag を見て、有効時のみ本サービスを呼ぶ前提)
 *
 * 関連:
 *   - 仕様: docs/business/STRIPE_BILLING.md §4 (フロー)
 *   - 詳細設計: docs/design/STRIPE_TECHNICAL_DESIGN.md (各セクション)
 *   - 環境変数: docs/operations/STRIPE_SETUP.md
 */

import type Stripe from 'stripe';
import { prisma } from '@/lib/db';
import {
  getStripe,
  getStripePriceConfig,
  getStoragePriceId,
  STRIPE_METER_EVENT_NAMES,
  type StripeMeterCallType,
} from '@/lib/stripe';
import {
  withStripeError,
  type StripeOperationResult,
} from '@/lib/stripe-error-handler';
import { getTenantCurrentYearMonth } from '@/lib/tenant-time';
import { markPendingInvoiceAsReplacedByStripe } from './billing-management.service';

// ============================================================
// §1. Stripe Customer の作成・取得
// ============================================================

/**
 * テナント用の Stripe Customer を取得 or 新規作成 (idempotent)。
 *
 * - 既に `tenant.stripeCustomerId` がセット済ならその Customer を返す
 * - 未設定なら新規作成し、DB に保存
 * - idempotency_key: `customer:create:{tenantId}` で重複作成を Stripe 側でも防ぐ
 *
 * @returns Stripe Customer または失敗時の Result.error
 */
export async function createOrGetStripeCustomer(
  tenantId: string,
): Promise<StripeOperationResult<Stripe.Customer>> {
  // PR-V7 横展開 (2026-05-19): 削除済テナントへの Stripe Customer 作成を防ぐため
  //   findUnique → findFirst + deletedAt: null フィルタ。auth 経路では到達しない想定だが defense in depth。
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      id: true,
      name: true,
      stripeCustomerId: true,
      billingContactEmail: true,
      billingCompanyName: true,
      billingContactName: true,
    },
  });
  if (tenant == null) {
    return { ok: false, code: 'invalid_request', userMessage: 'テナントが見つかりません', detail: 'tenant_not_found' };
  }

  const stripe = getStripe();

  // 既存 Customer の流用
  if (tenant.stripeCustomerId != null) {
    return await withStripeError(() => stripe.customers.retrieve(tenant.stripeCustomerId!) as Promise<Stripe.Customer>);
  }

  // 新規作成
  const result = await withStripeError(() =>
    stripe.customers.create(
      {
        name: tenant.billingCompanyName ?? tenant.name,
        email: tenant.billingContactEmail ?? undefined,
        description: `Tasukiba Knowledge Relay tenant: ${tenant.id}`,
        metadata: {
          // Webhook 受信時にテナントを逆引きするためのメタデータ
          tenantId: tenant.id,
        },
      },
      {
        idempotencyKey: `customer:create:${tenantId}`,
      },
    ),
  );

  if (!result.ok) return result;

  // DB に保存
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { stripeCustomerId: result.value.id },
  });

  return result;
}

// ============================================================
// §2. Checkout Session (カード登録)
// ============================================================

/**
 * カード登録用の Stripe Checkout Session を作成 (= mode: 'setup')。
 *
 * フロー (詳細設計 §A-1):
 *   1. テナントの Stripe Customer を取得 or 作成
 *   2. Checkout Session を mode='setup' で作成 (= カード情報のトークン化のみ、課金しない)
 *   3. 顧客は session.url にリダイレクトされ、Stripe Checkout でカード入力
 *   4. 完了後、success_url (= `/api/tenants/me/billing/stripe/setup/complete?session_id=...&return_to=...`)
 *      に戻る → complete ハンドラで `completeStripeSetup()` を呼出
 *   5. complete ハンドラが最終的に `return_to?stripe_setup=success` (or failed) にリダイレクト
 *
 * @param returnUrl 最終的にユーザを戻す UI URL (= /settings/tenant)
 *                  クエリ `?stripe_setup=success` / `?stripe_setup=canceled` / `?stripe_setup=failed&reason=...`
 *                  が付与される
 */
export async function createCheckoutSessionForCardSetup(
  tenantId: string,
  returnUrl: string,
): Promise<StripeOperationResult<Stripe.Checkout.Session>> {
  const customerResult = await createOrGetStripeCustomer(tenantId);
  if (!customerResult.ok) return customerResult;

  const stripe = getStripe();

  // success_url は complete ハンドラに向け、session_id を Stripe が自動で展開する
  //   {CHECKOUT_SESSION_ID} は Stripe Checkout の標準 placeholder
  //   complete ハンドラ側で session_id + return_to を取得 → 処理 → 最終 UI へリダイレクト
  const baseOrigin = new URL(returnUrl).origin;
  const successUrl =
    `${baseOrigin}/api/tenants/me/billing/stripe/setup/complete` +
    `?session_id={CHECKOUT_SESSION_ID}` +
    `&return_to=${encodeURIComponent(returnUrl)}`;
  const cancelUrl = appendQuery(returnUrl, 'stripe_setup', 'canceled');

  // PR #425 デバッグ: success_url 本番化問題の最終確認用 (検証完了後に削除)
  // eslint-disable-next-line no-console
  console.log('[stripe-checkout-create] debug', {
    receivedReturnUrl: returnUrl,
    baseOrigin,
    successUrl,
    cancelUrl,
  });

  return await withStripeError(() =>
    stripe.checkout.sessions.create(
      {
        mode: 'setup',
        customer: customerResult.value.id,
        payment_method_types: ['card'],
        success_url: successUrl,
        cancel_url: cancelUrl,
        locale: 'ja',
      },
      {
        // Checkout Session はリトライ可能性があるので毎回新規 UUID
        idempotencyKey: `checkout:setup:${tenantId}:${cryptoRandom()}`,
      },
    ),
  );
}

// ============================================================
// §2-bis. Setup 完了処理 (= Checkout 戻り後の Subscription 作成)
// ============================================================

export type CompleteStripeSetupSuccess = {
  subscriptionId: string;
  customerId: string;
  paymentMethodId: string;
};

/**
 * Stripe Checkout 完了後の最終処理 (詳細設計 §A-1 Phase 1-4)。
 *
 * - GET /api/tenants/me/billing/stripe/setup/complete (= success_url のハンドラ) から呼ばれる
 * - session 検証 → PaymentMethod 取得 → DB 暫定保存 (Phase 2) → Subscription 作成 (Phase 3) → 確定 (Phase 4)
 * - 失敗時は呼出側が UI へリダイレクトで失敗を伝える (= tenant.paymentMethod は変更しないまま)
 *
 * 冪等性: 同じ session_id で 2 回呼ばれた場合、tenant.paymentMethod 既に credit_card なら ok
 *
 * @param tenantId 自テナント ID (= session の authentication 済みユーザのテナント)
 * @param sessionId Stripe Checkout Session ID
 * @param billingCycleAnchor Subscription の billing_cycle_anchor (= JST 月初 UNIX 秒)
 */
export async function completeStripeSetup(
  tenantId: string,
  sessionId: string,
  billingCycleAnchor: number | null,
): Promise<StripeOperationResult<CompleteStripeSetupSuccess>> {
  const stripe = getStripe();

  // Step 1: Session 検証
  const sessionResult = await withStripeError(() => stripe.checkout.sessions.retrieve(sessionId));
  if (!sessionResult.ok) return sessionResult;
  const session = sessionResult.value;

  if (session.status !== 'complete') {
    return {
      ok: false,
      code: 'invalid_request',
      userMessage: 'カード登録が完了していません',
      detail: `session_status_${session.status ?? 'unknown'}`,
    };
  }
  if (session.mode !== 'setup') {
    return {
      ok: false,
      code: 'invalid_request',
      userMessage: 'Session の mode が不正です',
      detail: 'session_mode_not_setup',
    };
  }

  // session.customer をテナントの stripeCustomerId と照合 (= 越境防止)
  // PR-V7 横展開 (2026-05-19): completeStripeSetup で削除済テナントの setup 完了処理を防ぐ
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      paymentMethod: true,
      stripeCustomerId: true,
      storageAddonPlan: true,
      // PR-V7a (2026-05-19): 二重課金防止のため、テナント TZ で「現在の年月」を判定
      timezone: true,
    },
  });
  if (tenant == null) {
    return {
      ok: false,
      code: 'invalid_request',
      userMessage: 'テナントが見つかりません',
      detail: 'tenant_not_found',
    };
  }
  const sessionCustomerId =
    typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;
  if (sessionCustomerId == null || sessionCustomerId !== tenant.stripeCustomerId) {
    return {
      ok: false,
      code: 'invalid_request',
      userMessage: 'カード登録セッションがテナントと一致しません',
      detail: 'session_customer_mismatch',
    };
  }

  // 既に credit_card に切替済なら冪等成功 (= setup 重複実行の安全側)
  if (tenant.paymentMethod === 'credit_card') {
    return {
      ok: true,
      value: {
        subscriptionId: 'already_set_up',
        customerId: sessionCustomerId,
        paymentMethodId: 'already_set_up',
      },
    };
  }

  // Step 2: SetupIntent から PaymentMethod ID を取得
  const setupIntentId =
    typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id ?? null;
  if (setupIntentId == null) {
    return {
      ok: false,
      code: 'invalid_request',
      userMessage: 'SetupIntent が見つかりません',
      detail: 'setup_intent_missing',
    };
  }
  const setupIntentResult = await withStripeError(() => stripe.setupIntents.retrieve(setupIntentId));
  if (!setupIntentResult.ok) return setupIntentResult;
  const paymentMethodId =
    typeof setupIntentResult.value.payment_method === 'string'
      ? setupIntentResult.value.payment_method
      : setupIntentResult.value.payment_method?.id ?? null;
  if (paymentMethodId == null) {
    return {
      ok: false,
      code: 'invalid_request',
      userMessage: 'PaymentMethod が取得できませんでした',
      detail: 'payment_method_missing',
    };
  }

  // Step 3: DB に暫定保存 (Phase 2 / 詳細設計 §A-1)
  //   この時点で paymentMethod はまだ invoice のまま、Customer / PaymentMethod ID のみ保存
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      stripeDefaultPaymentMethodId: paymentMethodId,
      cardLastVerifiedAt: new Date(),
      cardVerificationStatus: 'valid',
    },
  });

  // Step 4: Subscription 作成 (Phase 3)
  const subscriptionResult = await createSubscriptionForTenant({
    tenantId,
    storageAddonPlan: tenant.storageAddonPlan ?? 'standard',
    billingCycleAnchor,
    paymentMethodId,
  });
  if (!subscriptionResult.ok) {
    // 補償処理: tenant.stripeDefaultPaymentMethodId は残してよい (= 次回 setup 時に再利用)
    return subscriptionResult;
  }
  const subscription = subscriptionResult.value;

  // Step 5: paymentMethod 切替を確定 (Phase 4)
  //   Subscription Item ID を抽出して保存
  //   PR-V7a (2026-05-19): 同一トランザクション内で「二重課金防止」も実施。
  //     月途中で invoice → credit_card 切替時、テナント TZ 基準の「現在月」に
  //     pending 状態の invoice/bank_transfer BillingHistory があれば
  //     status='replaced_by_stripe' に更新 (= Stripe Subscription 側で同月分が請求される)。
  const prices = getStripePriceConfig();
  const haikuItem = subscription.items.data.find((i) => i.price.id === prices.haiku);
  const sonnetItem = subscription.items.data.find((i) => i.price.id === prices.sonnet);
  const storageItem = subscription.items.data.find(
    (i) => i.price.id === prices.storagePlus || i.price.id === prices.storagePro,
  );

  const currentYearMonth = getTenantCurrentYearMonth(
    new Date(),
    tenant.timezone ?? 'Asia/Tokyo',
  );

  await prisma.$transaction(async (tx) => {
    await tx.tenant.update({
      where: { id: tenantId },
      data: {
        stripeSubscriptionId: subscription.id,
        stripeSubscriptionStatus: subscription.status,
        stripeSubscriptionItemHaikuId: haikuItem?.id ?? null,
        stripeSubscriptionItemSonnetId: sonnetItem?.id ?? null,
        stripeSubscriptionItemStorageId: storageItem?.id ?? null,
        paymentMethod: 'credit_card',
      },
    });
    // PR-V7a (2026-05-19): 二重課金防止 (= billing-management.service の helper を経由)
    await markPendingInvoiceAsReplacedByStripe(tx, tenantId, currentYearMonth);
  });

  return {
    ok: true,
    value: {
      subscriptionId: subscription.id,
      customerId: sessionCustomerId,
      paymentMethodId,
    },
  };
}

// ============================================================
// §3. Customer Portal (カード更新・履歴閲覧)
// ============================================================

/**
 * Stripe Customer Portal Session を作成。
 *
 * - 顧客は session.url にリダイレクトされ、カード変更 / 履歴ダウンロード / etc.
 * - return_url に戻ったときは UI 側で「ポータルから戻りました」のトースト
 *
 * 前提: テナントが既に stripeCustomerId を持っている (= setup 完了済)
 */
export async function createCustomerPortalSession(
  tenantId: string,
  returnUrl: string,
): Promise<StripeOperationResult<Stripe.BillingPortal.Session>> {
  // PR-V7 横展開 (2026-05-19): 削除済テナントの Portal アクセスを防ぐ
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: { stripeCustomerId: true },
  });
  if (tenant == null || tenant.stripeCustomerId == null) {
    return {
      ok: false,
      code: 'invalid_request',
      userMessage: 'Stripe Customer が未登録です。先にクレジットカード払いに切替えてください',
      detail: 'stripe_customer_id_missing',
    };
  }

  const stripe = getStripe();
  return await withStripeError(() =>
    stripe.billingPortal.sessions.create(
      {
        customer: tenant.stripeCustomerId!,
        return_url: appendQuery(returnUrl, 'from', 'portal'),
      },
      {
        idempotencyKey: `portal:${tenantId}:${cryptoRandom()}`,
      },
    ),
  );
}

// ============================================================
// §4. カード検証 ($0 SetupIntent)
// ============================================================

export type CardVerificationStatus = 'valid' | 'expired' | 'declined' | 'never_verified';

export type VerifyCardResult = {
  status: CardVerificationStatus;
  /** ユーザに表示する失敗理由 (= 検証失敗時のみ、成功時は undefined) */
  failureReason?: string;
  /** カード期限切れ判定の根拠 (= card.exp_year / exp_month) */
  cardExpiresAt?: { year: number; month: number };
};

/**
 * テナントの登録カードを検証 (= プラン変更時 + 月初検証 cron で呼出)。
 *
 * 検証ステップ (詳細設計 §4.4):
 *   1. stripe.paymentMethods.retrieve でカード情報取得
 *   2. カード期限切れチェック (= card.exp_year / exp_month が現在より前)
 *   3. $0 SetupIntent で「請求可能か」テスト (= Authorization-only verification)
 *
 * 副作用:
 *   - 検証成功時: `tenant.cardLastVerifiedAt = now`, `cardVerificationStatus = 'valid'`
 *   - 検証失敗時: `cardVerificationStatus = 'expired' / 'declined'` (lastVerifiedAt は更新しない)
 */
export async function verifyTenantCard(
  tenantId: string,
): Promise<StripeOperationResult<VerifyCardResult>> {
  // PR-V7 横展開 (2026-05-19): 削除済テナントへの SetupIntent を防ぐ
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      stripeCustomerId: true,
      stripeDefaultPaymentMethodId: true,
    },
  });
  if (tenant == null) {
    return { ok: false, code: 'invalid_request', userMessage: 'テナントが見つかりません', detail: 'tenant_not_found' };
  }
  if (tenant.stripeCustomerId == null || tenant.stripeDefaultPaymentMethodId == null) {
    return {
      ok: false,
      code: 'invalid_request',
      userMessage: 'クレジットカードが未登録です',
      detail: 'card_not_registered',
    };
  }

  const stripe = getStripe();

  // Step 1: PaymentMethod を取得して期限切れチェック
  const pmResult = await withStripeError(() =>
    stripe.paymentMethods.retrieve(tenant.stripeDefaultPaymentMethodId!),
  );
  if (!pmResult.ok) return pmResult;

  const card = pmResult.value.card;
  if (card == null) {
    return {
      ok: true,
      value: {
        status: 'declined',
        failureReason: 'card_information_not_available',
      },
    };
  }

  // 期限切れ判定 (= 現在の年月と比較)
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1; // 1-12
  const cardExpired =
    card.exp_year < currentYear ||
    (card.exp_year === currentYear && card.exp_month < currentMonth);

  if (cardExpired) {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { cardVerificationStatus: 'expired' },
    });
    return {
      ok: true,
      value: {
        status: 'expired',
        failureReason: 'expired_card',
        cardExpiresAt: { year: card.exp_year, month: card.exp_month },
      },
    };
  }

  // Step 2: $0 SetupIntent で「請求可能か」テスト
  //   - SetupIntent.confirm で実際にカード認証を Stripe → カード会社へ問い合わせ
  //   - 失敗時は StripeCardError が throw され、withStripeError で card_declined として返却される
  const setupIntentResult = await withStripeError(() =>
    stripe.setupIntents.create(
      {
        customer: tenant.stripeCustomerId!,
        payment_method: tenant.stripeDefaultPaymentMethodId!,
        confirm: true,
        usage: 'off_session',
        // off_session = 顧客が画面にいない状態でも引落可能 (= Metered Billing 用途に必須)
      },
      {
        idempotencyKey: `card:verify:${tenantId}:${currentYear}:${currentMonth}`,
      },
    ),
  );

  if (!setupIntentResult.ok) {
    // card_declined の場合
    if (setupIntentResult.code === 'card_declined') {
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { cardVerificationStatus: 'declined' },
      });
      return {
        ok: true,
        value: {
          status: 'declined',
          failureReason: setupIntentResult.declineCode,
        },
      };
    }
    return setupIntentResult;
  }

  // SetupIntent.status が 'succeeded' なら検証成功
  if (setupIntentResult.value.status !== 'succeeded') {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { cardVerificationStatus: 'declined' },
    });
    return {
      ok: true,
      value: {
        status: 'declined',
        failureReason: setupIntentResult.value.last_setup_error?.code ?? 'verification_failed',
      },
    };
  }

  // 検証成功
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      cardLastVerifiedAt: now,
      cardVerificationStatus: 'valid',
    },
  });

  return {
    ok: true,
    value: {
      status: 'valid',
      cardExpiresAt: { year: card.exp_year, month: card.exp_month },
    },
  };
}

// ============================================================
// §5. Subscription 作成
// ============================================================

export type SubscriptionCreationInput = {
  tenantId: string;
  /** Storage add-on plan ('standard' / 'plus' / 'pro_storage') */
  storageAddonPlan: string;
  /** billing_cycle_anchor の Unix 秒。null なら現時刻起点 */
  billingCycleAnchor: number | null;
  /** payment_method ID (= setup フローで取得した pm_xxx) */
  paymentMethodId: string;
};

/**
 * テナントの Stripe Subscription を作成 (= プラン契約)。
 *
 * - 全プラン (Haiku, Sonnet, Storage) の Subscription Item を作成
 *   - Haiku / Sonnet: Metered (= 使った分だけ、Usage Record で課金)
 *   - Storage Plus / Pro: Recurring 固定額
 *   - Storage standard は Stripe Item を作らない (= ¥0)
 * - billing_cycle_anchor で JST 月末締めに揃える (= 詳細設計 §C-3)
 * - automatic_tax: true で Stripe Tax (インボイス制度対応)
 *
 * @returns 作成された Subscription
 */
export async function createSubscriptionForTenant(
  input: SubscriptionCreationInput,
): Promise<StripeOperationResult<Stripe.Subscription>> {
  // PR-V7 横展開 (2026-05-19): 削除済テナントの Subscription 作成を防ぐ
  const tenant = await prisma.tenant.findFirst({
    where: { id: input.tenantId, deletedAt: null },
    select: { stripeCustomerId: true },
  });
  if (tenant == null || tenant.stripeCustomerId == null) {
    return {
      ok: false,
      code: 'invalid_request',
      userMessage: 'Stripe Customer が未登録です',
      detail: 'stripe_customer_id_missing',
    };
  }

  const stripe = getStripe();
  const prices = getStripePriceConfig();
  const storagePriceId = getStoragePriceId(input.storageAddonPlan);

  // Subscription Items: 全プラン共存 (= Usage 送信先のみ plan 別に切替、詳細設計 §C-2)
  const items: Stripe.SubscriptionCreateParams.Item[] = [
    { price: prices.haiku },
    { price: prices.sonnet },
  ];
  if (storagePriceId != null) {
    items.push({ price: storagePriceId });
  }

  const params: Stripe.SubscriptionCreateParams = {
    customer: tenant.stripeCustomerId,
    items,
    default_payment_method: input.paymentMethodId,
    automatic_tax: { enabled: true },
    proration_behavior: 'none', // 詳細設計 §C-1
    metadata: {
      tenantId: input.tenantId,
    },
  };

  // billing_cycle_anchor を指定 (= JST 月初に固定、詳細設計 §C-3)
  if (input.billingCycleAnchor != null) {
    params.billing_cycle_anchor = input.billingCycleAnchor;
  }

  return await withStripeError(() =>
    stripe.subscriptions.create(params, {
      idempotencyKey: `subscription:create:${input.tenantId}`,
    }),
  );
}

// ============================================================
// §6. Usage Record 送信 (= リアルタイム使用量レポート)
// ============================================================

export type ReportUsageInput = {
  /**
   * Stripe Customer ID (= tenant.stripeCustomerId)。
   * PR-V8 (2026-05-19): 旧 Subscription Item ID ベースから Meter API ベースに移行。
   * Meter API は Customer 単位で送信し、Stripe 側で active subscription を経由して課金される。
   */
  stripeCustomerId: string;
  /** Meter event 名 ('haiku' or 'sonnet'、STRIPE_METER_EVENT_NAMES で event_name に変換) */
  callType: StripeMeterCallType;
  /** 使用量 (通常 1、bulk 操作で N) */
  quantity: number;
  /** 元の API 呼び出し時刻 (= Meter event の timestamp、過去 35 日以内まで受領可) */
  occurredAt: Date;
  /** identifier として使う ApiCallLog.id (= 重複送信防止 = Meter API の冪等性キー) */
  apiCallLogId: string;
};

/**
 * Stripe Meter Event を送信 (= PR-V8 / 2026-05-19 で旧 Usage Record API から移行)。
 *
 * 旧仕様 (= subscriptionItems.createUsageRecord):
 *   - Subscription Item ID 単位で送信
 *   - quantity + timestamp + action='increment'
 *
 * 新仕様 (= billing.meterEvents.create):
 *   - Meter event_name + Customer ID 単位で送信
 *   - Stripe は Customer の active Subscription を自動解決して課金
 *   - identifier で重複送信を防ぐ (= 24h 以内の同一 identifier は無視される)
 *
 * 設計方針 (詳細設計 §D-1):
 *   - 同期送信 (= API 応答性を損なう) は避ける。本関数は cron / queue から呼ばれる
 *   - apiCallLogId を identifier に使い重複送信防止
 *   - timestamp は過去日時 OK (= 月途中切替時の backfill にも使う、過去 35 日以内)
 *
 * 注: withMeteredLLM からの直接呼出は禁止 (= stripe_usage_record_queue に積んで、cron で本関数を呼ぶ)
 */
export async function reportUsage(
  input: ReportUsageInput,
): Promise<StripeOperationResult<Stripe.Billing.MeterEvent>> {
  const stripe = getStripe();
  const eventName = STRIPE_METER_EVENT_NAMES[input.callType];
  return await withStripeError(() =>
    stripe.billing.meterEvents.create({
      event_name: eventName,
      payload: {
        stripe_customer_id: input.stripeCustomerId,
        // Meter API の payload.value は文字列で渡す (= Stripe SDK の型定義)
        value: String(input.quantity),
      },
      // identifier で重複送信防止 (= Stripe 側で 24h 以内の同一 identifier は無視)
      identifier: `usage:${input.callType}:${input.apiCallLogId}`,
      timestamp: Math.floor(input.occurredAt.getTime() / 1000),
    }),
  );
}

// ============================================================
// §7. Storage Add-on プラン変更 → Stripe Subscription Item sync (PR-V7 #2 / 2026-05-19)
// ============================================================

/**
 * Storage add-on プラン変更を Stripe Subscription Item に反映する。
 *
 * 仕様: docs/business/STRIPE_BILLING.md §1 + storage-addon.ts ADDON_MONTHLY_JPY
 *   - 'standard' (¥0) = Stripe Subscription Item なし
 *   - 'plus' (¥500/月) = STRIPE_PRICE_STORAGE_PLUS の Item
 *   - 'pro_storage' (¥1500/月) = STRIPE_PRICE_STORAGE_PRO の Item
 *   - 'enterprise' (¥5000/月) = Stripe Item なし (= manual billing)
 *
 * 動作:
 *   - 元 standard / enterprise + 新 plus/pro_storage → 新 Item を `subscriptionItems.create`
 *   - 元 plus/pro_storage + 新 standard / enterprise → 既存 Item を `subscriptionItems.del`
 *   - 元 plus + 新 pro_storage (または逆) → 既存 Item を `subscriptionItems.update` で price 差替
 *   - 元 = 新 → no-op
 *
 * proration_behavior: 'none' (= Subscription 作成時の設定と整合、日割りなし)
 *
 * 副作用:
 *   - tenant.stripeSubscriptionItemStorageId を新 Item ID で更新 (削除時は null)
 *
 * 呼出側ユースケース:
 *   - updateStorageAddonPlan (= アップグレード即時反映)
 *   - applyScheduledStorageChanges (= ダウングレード月初 cron 適用時)
 */
export async function syncStorageAddonToStripe(
  tenantId: string,
  fromPlan: string,
  toPlan: string,
): Promise<StripeOperationResult<{ action: 'noop' | 'created' | 'updated' | 'deleted'; itemId: string | null }>> {
  // PR-V7 横展開 (2026-05-19): 削除済テナントへの Subscription Item 操作を防ぐ
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      paymentMethod: true,
      stripeSubscriptionId: true,
      stripeSubscriptionItemStorageId: true,
    },
  });
  if (tenant == null) {
    return { ok: false, code: 'invalid_request', userMessage: 'テナントが見つかりません', detail: 'tenant_not_found' };
  }
  // credit_card 払いでない / Subscription 未登録 → no-op
  if (tenant.paymentMethod !== 'credit_card' || tenant.stripeSubscriptionId == null) {
    return { ok: true, value: { action: 'noop', itemId: tenant.stripeSubscriptionItemStorageId } };
  }

  const fromPriceId = getStoragePriceId(fromPlan);
  const toPriceId = getStoragePriceId(toPlan);

  // 両方とも Stripe 対象外 (= standard / enterprise) → no-op
  if (fromPriceId == null && toPriceId == null) {
    return { ok: true, value: { action: 'noop', itemId: null } };
  }

  const stripe = getStripe();
  const idempotencyBase = `storage:${tenantId}:${fromPlan}_to_${toPlan}`;

  // Case A: 新規 Item 作成 (= 元 standard/enterprise → 新 plus/pro_storage)
  if (fromPriceId == null && toPriceId != null) {
    const result = await withStripeError(() =>
      stripe.subscriptionItems.create(
        {
          subscription: tenant.stripeSubscriptionId!,
          price: toPriceId,
          proration_behavior: 'none',
        },
        { idempotencyKey: `${idempotencyBase}:create` },
      ),
    );
    if (!result.ok) return result;
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { stripeSubscriptionItemStorageId: result.value.id },
    });
    return { ok: true, value: { action: 'created', itemId: result.value.id } };
  }

  // Case B: 既存 Item 削除 (= 元 plus/pro_storage → 新 standard/enterprise)
  if (fromPriceId != null && toPriceId == null) {
    if (tenant.stripeSubscriptionItemStorageId == null) {
      // DB と Stripe の状態不整合: 元 plus/pro なのに ItemId が null。no-op + 警告 (= 既に削除済の想定)
      return { ok: true, value: { action: 'noop', itemId: null } };
    }
    const result = await withStripeError(() =>
      stripe.subscriptionItems.del(tenant.stripeSubscriptionItemStorageId!, {
        proration_behavior: 'none',
      }),
    );
    if (!result.ok) return result;
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { stripeSubscriptionItemStorageId: null },
    });
    return { ok: true, value: { action: 'deleted', itemId: null } };
  }

  // Case C: 既存 Item の price 変更 (= plus ↔ pro_storage)
  if (fromPriceId != null && toPriceId != null && fromPriceId !== toPriceId) {
    if (tenant.stripeSubscriptionItemStorageId == null) {
      // DB 不整合: ItemId なし + plan は plus/pro_storage → 新規 create にフォールバック
      const result = await withStripeError(() =>
        stripe.subscriptionItems.create(
          {
            subscription: tenant.stripeSubscriptionId!,
            price: toPriceId,
            proration_behavior: 'none',
          },
          { idempotencyKey: `${idempotencyBase}:fallback_create` },
        ),
      );
      if (!result.ok) return result;
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { stripeSubscriptionItemStorageId: result.value.id },
      });
      return { ok: true, value: { action: 'created', itemId: result.value.id } };
    }
    const result = await withStripeError(() =>
      stripe.subscriptionItems.update(tenant.stripeSubscriptionItemStorageId!, {
        price: toPriceId,
        proration_behavior: 'none',
      }),
    );
    if (!result.ok) return result;
    return {
      ok: true,
      value: { action: 'updated', itemId: tenant.stripeSubscriptionItemStorageId },
    };
  }

  // fromPriceId === toPriceId (= 同一 Price ID) → no-op
  return { ok: true, value: { action: 'noop', itemId: tenant.stripeSubscriptionItemStorageId } };
}

// ============================================================
// §8. Subscription キャンセル (PR-V7 #1 / #3 / 2026-05-19)
// ============================================================

/**
 * テナントの Stripe Subscription をキャンセル (= 自動引落停止)。
 *
 * 呼出側のユースケース:
 *   - #1 テナント解約 (`deleteTenant`): credit_card 払い顧客の解約時に引落を止めないと
 *     Storage add-on 等の固定費が永続的に引き落とされ続けクレーム不可避
 *   - #3 credit_card → invoice 戻し: 月途中で paymentMethod を invoice に戻した時、
 *     Stripe Subscription を残すと当月の Stripe Invoice と運営手動 invoice の二重請求になる
 *
 * 設計判断:
 *   - `invoice_now: true` で **未請求の Usage を最終 Invoice 化** (= revenue loss 防止)
 *   - `prorate: false` で日割り計算なし (= proration_behavior と整合、Subscription 作成時の設定継続)
 *   - 失敗時も throw せず Result 型で返却 (= 呼出側が成否を判断、テナント解約は失敗してもDB側は完了させる)
 *   - 既に canceled の場合 (= Webhook 経由で既に canceled に倒れている) は invalid_request だが
 *     呼出側で「キャンセル不要」として扱える
 *
 * @returns
 *   `{ ok: true }`: キャンセル成功または「キャンセル不要」(= subscriptionId なし / 既 canceled)
 *   `{ ok: false }`: Stripe API 失敗 (= 呼出側で auditLog + super_admin 通知すべき)
 */
export async function cancelTenantStripeSubscription(
  tenantId: string,
): Promise<StripeOperationResult<{ canceled: boolean; reason?: string }>> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { stripeSubscriptionId: true, stripeSubscriptionStatus: true, paymentMethod: true },
  });
  if (tenant == null) {
    return { ok: true, value: { canceled: false, reason: 'tenant_not_found' } };
  }
  // Subscription が無ければキャンセル不要 (= 元から invoice 払い等)
  if (tenant.stripeSubscriptionId == null) {
    return { ok: true, value: { canceled: false, reason: 'no_subscription' } };
  }
  // 既に canceled なら何もしない (= Webhook 経由で先に倒れている可能性)
  if (tenant.stripeSubscriptionStatus === 'canceled') {
    return { ok: true, value: { canceled: false, reason: 'already_canceled' } };
  }

  const stripe = getStripe();
  const result = await withStripeError(() =>
    stripe.subscriptions.cancel(tenant.stripeSubscriptionId!, {
      invoice_now: true, // 未請求の Usage を最終 Invoice 化
      prorate: false,
    }),
  );

  if (!result.ok) {
    // 既に canceled だった場合 (= invalid_request) は成功扱い
    if (result.code === 'invalid_request' && /canceled|no such subscription/i.test(result.detail)) {
      return { ok: true, value: { canceled: false, reason: 'already_canceled_stripe_side' } };
    }
    return result;
  }

  // DB は Webhook 経由 (= customer.subscription.deleted) で stripeSubscriptionStatus='canceled' に倒れるが、
  // Webhook 遅延を防ぐため呼出側で即時更新するなら個別に行う (= 本関数は Stripe API 呼出のみに責務集中)
  return { ok: true, value: { canceled: true } };
}

// ============================================================
// 内部ヘルパ
// ============================================================

/**
 * URL にクエリパラメタを追加する純関数。既存クエリは保持。
 *
 * 例: appendQuery('https://x.com/path?a=1', 'b', '2') → 'https://x.com/path?a=1&b=2'
 */
function appendQuery(url: string, key: string, value: string): string {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

/**
 * idempotency key 用のランダム文字列生成 (= Node.js 標準の crypto.randomUUID)。
 */
function cryptoRandom(): string {
  // Node.js 19+ では globalThis.crypto.randomUUID が利用可能
  // 互換性のため Buffer ベースのフォールバック
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // fallback: timestamp + Math.random (= 完全な UUID ではないが idempotency 用途には十分)
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
