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
} from '@/lib/stripe';
import {
  withStripeError,
  type StripeOperationResult,
} from '@/lib/stripe-error-handler';

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
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
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
 * フロー:
 *   1. テナントの Stripe Customer を取得 or 作成
 *   2. Checkout Session を mode='setup' で作成 (= カード情報のトークン化のみ、課金しない)
 *   3. 顧客は session.url にリダイレクトされ、Stripe Checkout でカード入力
 *   4. 完了後、`return_url?stripe_setup=success` に戻る
 *   5. setup/complete ハンドラで session.setup_intent から payment_method を取得 → DB に保存
 *
 * @param returnUrl Stripe Checkout 完了 (or キャンセル) 時の戻り先 URL
 *                  クエリ `?stripe_setup=success` / `?stripe_setup=canceled` が付与される
 */
export async function createCheckoutSessionForCardSetup(
  tenantId: string,
  returnUrl: string,
): Promise<StripeOperationResult<Stripe.Checkout.Session>> {
  const customerResult = await createOrGetStripeCustomer(tenantId);
  if (!customerResult.ok) return customerResult;

  const stripe = getStripe();
  const successUrl = appendQuery(returnUrl, 'stripe_setup', 'success');
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
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
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
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
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
  const tenant = await prisma.tenant.findUnique({
    where: { id: input.tenantId },
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
  /** Stripe Subscription Item ID (= haiku or sonnet 用、tenant の subscriptionItemId を渡す) */
  subscriptionItemId: string;
  /** 使用量 (通常 1、bulk 操作で N) */
  quantity: number;
  /** 元の API 呼び出し時刻 (= Stripe Usage Record の timestamp、過去 35 日以内まで受領可) */
  occurredAt: Date;
  /** idempotency_key として使う ApiCallLog.id (= 重複送信防止) */
  apiCallLogId: string;
};

/**
 * Stripe SubscriptionItem に Usage Record を送信。
 *
 * 設計方針 (詳細設計 §D-1):
 *   - 同期送信 (= API 応答性を損なう) は避ける。本関数は cron / queue から呼ばれる
 *   - apiCallLogId を idempotency_key として送信 → 重複送信防止
 *   - timestamp は過去日時 OK (= 月途中切替時の backfill にも使う)
 *
 * 注: withMeteredLLM からの直接呼出は禁止 (= stripe_usage_record_queue に積んで、cron で本関数を呼ぶ)
 */
export async function reportUsage(
  input: ReportUsageInput,
): Promise<StripeOperationResult<Stripe.UsageRecord>> {
  const stripe = getStripe();
  return await withStripeError(() =>
    stripe.subscriptionItems.createUsageRecord(
      input.subscriptionItemId,
      {
        quantity: input.quantity,
        timestamp: Math.floor(input.occurredAt.getTime() / 1000),
        action: 'increment',
      },
      {
        idempotencyKey: `usage:${input.subscriptionItemId}:${input.apiCallLogId}`,
      },
    ),
  );
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
