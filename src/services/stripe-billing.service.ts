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
// §2-ter. 既存カードでの再 setup (= Stripe Checkout を経由しない自動 Subscription 作成)
// ============================================================

/**
 * PR #425 (2026-05-22): 過去に登録したカード (= Stripe Customer の invoice_settings.default_payment_method)
 * を使って、Stripe Checkout を経由せず Subscription を即座に作成する UX 改善 API。
 *
 * 目的: 「銀行振込 → 一度 cancel → 再度カード払いに戻す」操作の度に
 *       新規 Stripe Checkout で同じカード番号を再入力させるのは UX が悪い。
 *       既に Customer に登録済の default_payment_method があれば、それで Subscription を再作成する。
 *
 * フロー:
 *   1. Stripe Customer の `invoice_settings.default_payment_method` を確認
 *   2. なければ null 返却 (= 呼出側で Stripe Checkout setup に強制遷移)
 *   3. あれば既存 active Subscription を全 cancel (= 二重 Subscription 防止、KDD §5.X+107)
 *   4. 新規 Subscription 作成 (= completeStripeSetup と同じロジック)
 *   5. DB に paymentMethod='credit_card' + sub_id + 関連 ID を保存
 *
 * 呼出側: POST /api/tenants/me/billing/stripe/setup-with-existing-card
 *
 * @returns 成功なら CompleteStripeSetupSuccess、既存カード無しなら null (= 呼出側で Checkout 強制遷移)
 */
export async function setupSubscriptionWithExistingCard(
  tenantId: string,
  billingCycleAnchor: number | null,
): Promise<StripeOperationResult<CompleteStripeSetupSuccess | null>> {
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      stripeCustomerId: true,
      timezone: true,
    },
  });
  if (tenant == null || tenant.stripeCustomerId == null) {
    // Customer 未作成 → そもそも既存カードが存在しない
    return { ok: true, value: null };
  }

  const stripe = getStripe();

  // Step 1: Customer の invoice_settings.default_payment_method を確認
  const customerResult = await withStripeError(() =>
    stripe.customers.retrieve(tenant.stripeCustomerId!, {
      expand: ['invoice_settings.default_payment_method'],
    }),
  );
  if (!customerResult.ok) return customerResult;
  if (customerResult.value.deleted) return { ok: true, value: null };
  const pm = customerResult.value.invoice_settings?.default_payment_method;
  if (!pm || typeof pm === 'string' || pm.type !== 'card' || !pm.card) {
    // 既存カードなし → 呼出側で Checkout 強制遷移
    return { ok: true, value: null };
  }
  const paymentMethodId = pm.id;

  // Step 2: 既存 active Subscription を全 cancel (KDD §5.X+107)
  await cancelAllActiveStripeSubscriptionsForCustomer(tenant.stripeCustomerId);

  // Step 3: 新規 Subscription 作成
  // chore/storage-addon-backend-removal (2026-05-26): storage addon プラン廃止に伴い storageAddonPlan 引数は撤去
  const subscriptionResult = await createSubscriptionForTenant({
    tenantId,
    billingCycleAnchor,
    paymentMethodId,
  });
  if (!subscriptionResult.ok) return subscriptionResult;
  const subscription = subscriptionResult.value;

  // Step 4: paymentMethod 切替を確定 (completeStripeSetup の Step 5 と同じ処理)
  const prices = getStripePriceConfig();
  const haikuItem = subscription.items.data.find((i) => i.price.id === prices.haiku);
  const sonnetItem = subscription.items.data.find((i) => i.price.id === prices.sonnet);
  // ADR-0022 (2026-06-01): Embedding Item は optional (STRIPE_PRICE_EMBEDDING 設定時のみ)
  const embeddingItem =
    prices.embedding != null
      ? subscription.items.data.find((i) => i.price.id === prices.embedding)
      : undefined;
  // ADR-0020 / 0021 (2026-05-30): DB 容量 / ファイルストレージ超過 Item も optional (Embedding と同パターン)
  const dbCapacityItem =
    prices.dbCapacityOverage != null
      ? subscription.items.data.find((i) => i.price.id === prices.dbCapacityOverage)
      : undefined;
  const storageFileItem =
    prices.storageFileOverage != null
      ? subscription.items.data.find((i) => i.price.id === prices.storageFileOverage)
      : undefined;
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
        // ADR-0022: Embedding Item ID も保存 (= 未設定なら null、Stripe-ready)
        stripeSubscriptionItemEmbeddingId: embeddingItem?.id ?? null,
        // ADR-0020 / 0021 (2026-05-30): DB 容量 / ファイルストレージ Item ID も保存 (= 未設定なら null)
        stripeSubscriptionItemDbCapacityId: dbCapacityItem?.id ?? null,
        stripeSubscriptionItemStorageFileId: storageFileItem?.id ?? null,
        stripeDefaultPaymentMethodId: paymentMethodId,
        cardLastVerifiedAt: new Date(),
        cardVerificationStatus: 'valid',
        paymentMethod: 'credit_card',
      },
    });
    await markPendingInvoiceAsReplacedByStripe(tx, tenantId, currentYearMonth);
  });

  // Step 5: Customer デフォルト同期 (KDD §5.X+108) は既に invoice_settings.default_payment_method が
  //         今回の paymentMethodId なので不要。ただし冪等性のため update を呼ぶ。
  await withStripeError(() =>
    stripe.customers.update(tenant.stripeCustomerId!, {
      invoice_settings: { default_payment_method: paymentMethodId },
    }),
  );

  return {
    ok: true,
    value: {
      subscriptionId: subscription.id,
      customerId: tenant.stripeCustomerId,
      paymentMethodId,
    },
  };
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
  // PR #425 (2026-05-22): stripeSubscriptionId も取得 (= 「カード変更モード」分岐判定に使用)
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      paymentMethod: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
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

  // PR #425 (2026-05-22) ★severity-1 一貫性★: 「カード変更モード」分岐。
  //
  // 既に Subscription が active な状態でユーザが「クレジットカード情報更新」ボタンを
  // 押した場合 (= カード差替え)、Subscription を再作成せず default_payment_method のみ
  // update する。これにより:
  //   - Subscription 維持 (= 当月以降の請求すべて新カードに、二重請求なし)
  //   - 3 点完全一致 (= アプリ画面 = Customer Portal デフォルト = 実引落カード)
  //   - ユーザの直感「カード変更したら次の引落も新カードに」を満たす
  //
  // 注意: Customer Portal の「デフォルト変更」では Subscription.default_payment_method は
  //       更新されないため、ユーザが「Portal で変えたつもりが古いカードに引落」事故を防ぐ。
  //       本サービスでは Customer Portal リンクを削除し、本ボタン経由でのみカード変更を許す。
  if (tenant.paymentMethod === 'credit_card' && tenant.stripeSubscriptionId != null) {
    // Step A: PaymentMethod が Customer に未 attach なら attach する (= 冪等的にエラー無視)
    const attachResult = await withStripeError(() =>
      stripe.paymentMethods.attach(paymentMethodId, { customer: sessionCustomerId }),
    );
    // 既に attach 済 (invalid_request) は無視。それ以外のエラーは本処理は続行可能なので継続。
    if (!attachResult.ok && attachResult.code !== 'invalid_request') {
      // eslint-disable-next-line no-console
      console.warn('[completeStripeSetup card-change-mode] paymentMethods.attach failed', attachResult.code);
    }

    // Step B: Subscription の default_payment_method を新カードに update
    const updateSubResult = await withStripeError(() =>
      stripe.subscriptions.update(tenant.stripeSubscriptionId!, {
        default_payment_method: paymentMethodId,
      }),
    );
    if (!updateSubResult.ok) return updateSubResult;

    // Step C: Customer.invoice_settings.default_payment_method も同期 (KDD §5.X+108 同様)
    await withStripeError(() =>
      stripe.customers.update(sessionCustomerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      }),
    );

    // Step D: DB の stripeDefaultPaymentMethodId + cardVerificationStatus 更新
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        stripeDefaultPaymentMethodId: paymentMethodId,
        cardLastVerifiedAt: new Date(),
        cardVerificationStatus: 'valid',
      },
    });

    return {
      ok: true,
      value: {
        subscriptionId: tenant.stripeSubscriptionId,
        customerId: sessionCustomerId,
        paymentMethodId,
      },
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

  // PR #425 (2026-05-22) ★severity-1 請求堅牢性★ Step 3.5: 既存 active Subscription を全 cancel。
  //
  // 目的: 「同一 Stripe Customer に複数 active Subscription が並存 → 月次請求二重発生」を防ぐ。
  //
  // 発生シナリオ:
  //   - TC-7 (UI cancel) を通らずに DB 直書きで paymentMethod='invoice' に変更されたケース
  //   - Webhook 同期遅延中の race condition (= cancel と再 setup の往復)
  //   - DB drift (= DB は sub_id=null、Stripe は active が残る)
  //
  //   いずれも completeStripeSetup を呼ぶ時点で Stripe Customer に古い active Subscription が
  //   残っていれば新規 Subscription と並存し、月次で両方から引落される事故が発生する。
  //
  // 対策: Step 4 で新規 Subscription を作成する前に、Stripe API で
  //       「同 Customer の active Subscription 一覧」を取得し、すべて cancel する。
  //       これにより DB drift があっても Stripe 側を強制的にクリーン化してから新規作成できる。
  //
  // 失敗時の挙動: cancel が失敗しても続行 (= Webhook で後追い cancel される可能性 / 多くは既 canceled)。
  //               Step 4 の Subscription 作成が成功すれば最終的に新 sub_id が DB に書き込まれる。
  await cancelAllActiveStripeSubscriptionsForCustomer(sessionCustomerId);

  // Step 4: Subscription 作成 (Phase 3)
  // chore/storage-addon-backend-removal (2026-05-26): storage addon プラン廃止に伴い storageAddonPlan 引数は撤去
  const subscriptionResult = await createSubscriptionForTenant({
    tenantId,
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
  // ADR-0022 (2026-06-01): Embedding Item は optional (STRIPE_PRICE_EMBEDDING 設定時のみ)
  const embeddingItem =
    prices.embedding != null
      ? subscription.items.data.find((i) => i.price.id === prices.embedding)
      : undefined;
  // ADR-0020 / 0021 (2026-05-30): DB 容量 / ファイルストレージ超過 Item も optional (Embedding と同パターン)
  const dbCapacityItem =
    prices.dbCapacityOverage != null
      ? subscription.items.data.find((i) => i.price.id === prices.dbCapacityOverage)
      : undefined;
  const storageFileItem =
    prices.storageFileOverage != null
      ? subscription.items.data.find((i) => i.price.id === prices.storageFileOverage)
      : undefined;

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
        // ADR-0022: Embedding Item ID も保存 (= 未設定なら null、Stripe-ready)
        stripeSubscriptionItemEmbeddingId: embeddingItem?.id ?? null,
        // ADR-0020 / 0021 (2026-05-30): DB 容量 / ファイルストレージ Item ID も保存 (= 未設定なら null)
        stripeSubscriptionItemDbCapacityId: dbCapacityItem?.id ?? null,
        stripeSubscriptionItemStorageFileId: storageFileItem?.id ?? null,
        paymentMethod: 'credit_card',
      },
    });
    // PR-V7a (2026-05-19): 二重課金防止 (= billing-management.service の helper を経由)
    await markPendingInvoiceAsReplacedByStripe(tx, tenantId, currentYearMonth);
  });

  // PR #425 (2026-05-22) ★severity-1 一貫性★ Step 6: Customer の invoice_settings.default_payment_method も同期。
  //
  // Stripe では Customer.default_payment_method と Subscription.default_payment_method は独立した別概念で、
  // Subscription 作成時に Customer 側のデフォルトは自動更新されない。本サービスではユーザに混乱を与えないよう
  // 「Subscription 引落カード = Customer デフォルトカード」を常に一致させる方針を取る。
  //
  // 効果:
  //   - Customer Portal で「現在のデフォルト」が必ず Subscription と同じカード
  //   - アプリ画面 (= getStripeCardSummary) = Customer Portal = 実引落カード の 3 点完全一致
  //
  // Customer Portal でユーザが手動でデフォルト変更した場合はその選択を尊重 (= 上書きしない)
  // が、次回 setup (= 新規 Subscription 作成) 時には新カードに同期される。
  //
  // 失敗時の挙動: 同期失敗は console.warn のみで続行 (= Subscription は既に作成成功している、
  //                Customer デフォルトは「ズレるだけ」で課金事故にはならない)
  const customerSyncResult = await withStripeError(() =>
    stripe.customers.update(sessionCustomerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId,
      },
    }),
  );
  if (!customerSyncResult.ok) {
    // eslint-disable-next-line no-console
    console.warn(
      '[completeStripeSetup] failed to sync Customer.invoice_settings.default_payment_method',
      customerSyncResult.code,
    );
  }

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
  /** billing_cycle_anchor の Unix 秒。null なら現時刻起点 */
  billingCycleAnchor: number | null;
  /** payment_method ID (= setup フローで取得した pm_xxx) */
  paymentMethodId: string;
};

/**
 * テナントの Stripe Subscription を作成 (= プラン契約)。
 *
 * - Haiku / Sonnet の Subscription Item を作成 (= Metered、Usage Record で課金)
 * - billing_cycle_anchor で JST 月末締めに揃える (= 詳細設計 §C-3)
 * - automatic_tax: true で Stripe Tax (インボイス制度対応)
 *
 * 履歴:
 *   chore/storage-addon-backend-removal (2026-05-26):
 *     ADR-0020/0021 で完全従量課金化されたため、旧 Storage add-on Subscription Item は撤去。
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

  // Subscription Items: Haiku + Sonnet + (optional) Embedding + (optional) DB capacity + (optional) Storage file。
  // ADR-0022 (2026-06-01) Stripe-ready 設計:
  //   - STRIPE_PRICE_EMBEDDING 未設定 (= リリース時の挙動): Haiku+Sonnet 2 本のみ
  //   - STRIPE_PRICE_EMBEDDING 設定済 (= 将来 Stripe 有効化時): 3 本目として Embedding を追加
  //     これにより withMeteredLLM が embedding event で投入する queue が flush 時に
  //     Subscription Item と紐付き、Stripe Invoice に Embedding 課金が反映される。
  //
  // ADR-0020 / 0021 (2026-05-30) Stripe-ready 設計 (Embedding と同パターン):
  //   - STRIPE_PRICE_DB_CAPACITY_OVERAGE / STRIPE_PRICE_STORAGE_FILE_OVERAGE 未設定: Item 追加せず旧挙動互換。
  //   - 設定済: Item として追加され、月初 cron が送信する Meter Event (円整数 quantity) が
  //     当該 Item に集約されて Stripe Invoice に反映される。これにより invoice 払いの BillingHistory
  //     (= BILLABLE_FEATURE_UNITS の ApiCallLog SUM) と Stripe Invoice の金額が完全 invariant 一致する。
  //
  //   コード変更ゼロで Stripe 有効化が完結する設計 (= env 設定だけで自動的に動き出す)。
  const items: Stripe.SubscriptionCreateParams.Item[] = [
    { price: prices.haiku },
    { price: prices.sonnet },
  ];
  if (prices.embedding != null) {
    items.push({ price: prices.embedding });
  }
  if (prices.dbCapacityOverage != null) {
    items.push({ price: prices.dbCapacityOverage });
  }
  if (prices.storageFileOverage != null) {
    items.push({ price: prices.storageFileOverage });
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

  // PR #425 (2026-05-22) ★severity-1 請求堅牢性★: idempotencyKey に paymentMethodId を含める。
  //
  // 旧キー `subscription:create:${tenantId}` だと、同テナントでカード再登録 (= 銀行振込→カード切替を
  // 繰り返す) するたびに「同じキー + 異なる default_payment_method」になり Stripe が
  // 「Keys for idempotent requests can only be reused with the same parameters」エラーで reject
  // (= ユーザ表示は processing_error)。本来のリトライ防止意図は「ネットワーク失敗時の同一リクエスト
  // 多重実行を防ぐ」ことなので、paymentMethodId が同じ = 同一試行とみなして冪等、paymentMethodId が
  // 異なる = 別試行とみなして新規作成、にする。これでカード切替フローが何度でも安全に動く。
  return await withStripeError(() =>
    stripe.subscriptions.create(params, {
      idempotencyKey: `subscription:create:${input.tenantId}:${input.paymentMethodId}`,
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
// §7. (削除済) Storage Add-on プラン変更 → Stripe Subscription Item sync
//
//   chore/storage-addon-backend-removal (2026-05-26):
//     ADR-0020 (DB 容量従量課金) + ADR-0021 (添付ファイル従量課金) で完全従量課金化されたため、
//     旧 4 段階プラン (Standard/Plus/Pro/Enterprise) の Stripe Item sync は撤去。
//     Stripe Subscription は Haiku + Sonnet の 2 Meter のみで構成される。
// ============================================================

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
    // 既に canceled だった場合 (= invalid_request) は成功扱い → DB クリアまで進む
    if (result.code === 'invalid_request' && /canceled|no such subscription/i.test(result.detail)) {
      await clearTenantStripeSubscriptionFields(tenantId);
      return { ok: true, value: { canceled: false, reason: 'already_canceled_stripe_side' } };
    }
    return result;
  }

  // PR #425 (2026-05-22) ★severity-1★: DB の Stripe Subscription / PaymentMethod フィールドを即時クリア。
  //   旧実装は Webhook (customer.subscription.deleted) で同期する設計だったが:
  //     - staging では Webhook 未設定 → 永久に sub_id が残る
  //     - 本番でも Webhook 同期の秒〜分単位ラグ中に再 setup を試みると Stripe 側で
  //       「既存 active Subscription あり」エラー → 「カード払い再切替不可」体験になる
  //   呼出側で即時クリアすることで Webhook 同期の有無に関わらず「クリーンな初期状態」を保証する。
  await clearTenantStripeSubscriptionFields(tenantId);
  return { ok: true, value: { canceled: true } };
}

/**
 * PR #425 (2026-05-22) ★severity-1 請求堅牢性★: 同一 Stripe Customer の全 active Subscription を cancel する。
 *
 * completeStripeSetup の Step 3.5 から呼ばれる「DB drift 修復 + 二重 Subscription 防止」用ヘルパ。
 * DB の stripeSubscriptionId が null でも Stripe 側に active が残っているケースを救う。
 *
 * 挙動:
 *   1. Stripe API で同 Customer の active Subscription を全件取得 (limit=100 で十分、通常は 0-1 件)
 *   2. 各 Subscription に対して cancel() を呼出 (失敗しても続行 = 既 canceled の冪等性ケース等)
 *   3. 全体的なエラーも throw しない (= 後続の Subscription 作成が本筋、cancel 失敗は warning レベル)
 *
 * 失敗時の挙動: 各 cancel 失敗は console.warn のみ (= 監視は別途 KDD §5.X+104 Phase 2 で reconcile cron 化予定)
 */
async function cancelAllActiveStripeSubscriptionsForCustomer(customerId: string): Promise<void> {
  const stripe = getStripe();
  const listResult = await withStripeError(() =>
    stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 100,
    }),
  );
  if (!listResult.ok) {
    // eslint-disable-next-line no-console
    console.warn('[completeStripeSetup] active subscription list failed', listResult.code);
    return;
  }
  for (const sub of listResult.value.data) {
    const cancelResult = await withStripeError(() =>
      stripe.subscriptions.cancel(sub.id, { invoice_now: true, prorate: false }),
    );
    if (!cancelResult.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        '[completeStripeSetup] failed to cancel orphan subscription',
        sub.id,
        cancelResult.code,
      );
    }
  }
}

/**
 * PR #425 (2026-05-22): Subscription cancel 直後に DB の Stripe 関連フィールドをクリアする内部ヘルパ。
 *
 * クリア対象:
 *   - stripeSubscriptionId / stripeSubscriptionStatus / stripeSubscriptionItem*
 *   - stripeDefaultPaymentMethodId / cardVerificationStatus / cardLastVerifiedAt
 *   - autoSuspendScheduledAt (= 自動 suspend 予定もクリア。Subscription 自体が消えた前提)
 *
 * クリアしない対象:
 *   - stripeCustomerId (= 再 setup 時に再利用するため保持。Customer 削除は別 API)
 */
async function clearTenantStripeSubscriptionFields(tenantId: string): Promise<void> {
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: 'canceled',
      stripeSubscriptionItemHaikuId: null,
      stripeSubscriptionItemSonnetId: null,
      // ADR-0022 (2026-06-01): Embedding Item ID もクリア (= Subscription 全体が消えた前提)
      stripeSubscriptionItemEmbeddingId: null,
      // ADR-0020 / 0021 (2026-05-30): DB 容量 / ファイルストレージ Item ID もクリア (Subscription 全体が消えた前提)
      stripeSubscriptionItemDbCapacityId: null,
      stripeSubscriptionItemStorageFileId: null,
      stripeDefaultPaymentMethodId: null,
      cardVerificationStatus: null,
      cardLastVerifiedAt: null,
      autoSuspendScheduledAt: null,
    },
  });
}

/**
 * PR #425 (2026-05-22): テナント画面表示用のカード情報サマリ取得。
 *
 * 目的: テナント管理者が「どのクレジットカードに毎月引き落とされるか」を画面で視認できるようにし、
 *       Stripe ダッシュボード側との一貫性 (= 画面に出ているカード = 実際に請求されるカード) を担保する。
 *
 * ★severity-1 重要設計★ Stripe Customer の `invoice_settings.default_payment_method` を
 * **リアルタイム取得** する (= DB キャッシュ `Tenant.stripeDefaultPaymentMethodId` は使わない)。
 * 理由: Customer Portal でカード変更 → Webhook で DB 同期、の経路は staging では Webhook 未設定で
 *       停止し、本番でも秒〜分単位の遅延がある。その間「画面のカード ≠ 請求カード」になり
 *       「カード変えたつもりが古いカードに引落された」事故が発生する。
 *       常に Stripe API から取得することで Webhook 同期の有無に関わらず一貫性を担保する。
 *
 * パフォーマンス: テナント設定画面表示時の 1 回呼出のみ。コスト微々たるもの (Stripe API 1 call)。
 *
 * - stripeCustomerId が null (= 未登録) なら null を返す
 * - Stripe API 失敗時も null を返す (= 画面遷移自体は止めない、UI 側でフォールバック表示)
 * - 戻り値はカード末尾 4 桁 + ブランド + 有効期限のみ (= PCI DSS 対象外の表示可能フィールド)
 *
 * 表示 UI: stripe-payment-method-section.tsx
 */
export type StripeCardSummary = {
  brand: string; // 'visa' | 'mastercard' | 'amex' | 'jcb' | 'diners' | 'discover' | 'unionpay' | 'unknown'
  last4: string; // '4242' 等
  expMonth: number; // 1-12
  expYear: number; // YYYY
};

export async function getStripeCardSummary(tenantId: string): Promise<StripeCardSummary | null> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { stripeCustomerId: true, stripeSubscriptionId: true },
  });
  if (tenant?.stripeCustomerId == null) return null;

  const stripe = getStripe();

  // ★severity-1 一貫性★ 「実際に月次請求されるカード」は Subscription.default_payment_method。
  // Customer.invoice_settings.default_payment_method は新規 Subscription 作成時の初期値であり、
  // 既存 Subscription の引落カードとは独立 (= ズレる可能性あり)。
  // 「画面のカード = 請求カード」一貫性のため、Subscription があれば必ずそちらを優先する。
  if (tenant.stripeSubscriptionId != null) {
    const subResult = await withStripeError(() =>
      stripe.subscriptions.retrieve(tenant.stripeSubscriptionId!, {
        expand: ['default_payment_method'],
      }),
    );
    if (subResult.ok) {
      const pm = subResult.value.default_payment_method;
      if (pm && typeof pm !== 'string' && pm.type === 'card' && pm.card) {
        return {
          brand: pm.card.brand,
          last4: pm.card.last4,
          expMonth: pm.card.exp_month,
          expYear: pm.card.exp_year,
        };
      }
      // Subscription.default_payment_method が null の場合は Customer フォールバックへ
      // (= Stripe 仕様: Subscription レベル未設定なら Customer レベルが請求カードになる)
    }
  }

  // フォールバック: Customer.invoice_settings.default_payment_method
  //   - Subscription 未作成テナント (= setup 前)
  //   - Subscription はあるが default_payment_method を設定していない (= Customer レベルから引落)
  const customerResult = await withStripeError(() =>
    stripe.customers.retrieve(tenant.stripeCustomerId!, {
      expand: ['invoice_settings.default_payment_method'],
    }),
  );
  if (!customerResult.ok) return null;
  const customer = customerResult.value;
  if (customer.deleted) return null;
  const pm = customer.invoice_settings?.default_payment_method;
  if (!pm || typeof pm === 'string' || pm.type !== 'card' || !pm.card) return null;
  return {
    brand: pm.card.brand,
    last4: pm.card.last4,
    expMonth: pm.card.exp_month,
    expYear: pm.card.exp_year,
  };
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
