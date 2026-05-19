/**
 * Stripe Webhook イベントハンドラ (PR-S4 / 2026-05-14)
 *
 * 役割:
 *   `/api/webhooks/stripe` から呼ばれ、Stripe Webhook イベントを type で分岐 → 個別ハンドラで処理。
 *
 * 設計方針 (STRIPE_BILLING.md §4 / §6 / §9):
 *   - **冪等性**: 呼出側 (route.ts) で `StripeWebhookEvent` を `id` (= Stripe event.id) で先に upsert する前提。
 *     本サービスは「処理済かどうか」のチェックを **持たない** (= route 側が責務)。
 *   - **失敗時は throw**: route.ts 側で catch して `errorMessage` を記録 + 5xx を返却 → Stripe が自動再送
 *   - **Stripe を信頼源とする**: ローカル DB が古い場合は Stripe 側の値で上書き
 *   - **未知の event.type は無視** (= 安全側、Stripe 側で配信設定が増えても落ちない)
 *   - **テナント解決**: `event.data.object.metadata.tenantId` を最優先 (= Stripe Customer / Subscription
 *     作成時に metadata に埋めている)。fallback として `tenant.stripeCustomerId` で逆引き。
 *
 * 処理対象 event (STRIPE_BILLING.md §3.2):
 *   - customer.subscription.created  → tenant.stripeSubscriptionId 等を sync
 *   - customer.subscription.updated  → status sync、past_due → autoSuspendScheduledAt セット、active → clear
 *   - customer.subscription.deleted  → tenant.stripeSubscriptionStatus = 'canceled'
 *   - invoice.created                → BillingHistory upsert (status='pending')
 *   - invoice.finalized              → BillingHistory 金額確定
 *   - invoice.paid                   → BillingHistory.status='paid'、payment_delinquent suspend なら resume
 *   - invoice.payment_failed         → BillingHistory.status='failed' + retryCount
 *   - payment_method.attached        → tenant.stripeDefaultPaymentMethodId 同期
 *   - payment_method.detached        → tenant.stripeDefaultPaymentMethodId クリア
 *   - payment_method.updated         → カード情報変更 (期限等) → cardVerificationStatus を 'never_verified' に戻す
 *   - customer.updated               → ログのみ (副作用なし)
 *
 * 関連:
 *   - 仕様: docs/business/STRIPE_BILLING.md §3.2 / §4.2-4.3 / §9.2
 *   - 冪等性テーブル: prisma/schema.prisma model StripeWebhookEvent
 *   - 自動 suspend: tenant.autoSuspendScheduledAt は日次 cron が拾って suspendTenant() を呼出 (PR-S6)
 */

import type Stripe from 'stripe';
import { prisma } from '@/lib/db';
import { getSystemUserId } from '@/lib/stripe';
import { resumeTenant } from '@/services/super-admin.service';

/**
 * past_due 受信から自動 suspend までの猶予 (= 3 日)。
 * STRIPE_BILLING.md §4.3: Smart Retries 全失敗 (= past_due) から +3 日で自動停止。
 */
const AUTO_SUSPEND_GRACE_DAYS = 3;

/**
 * Webhook 処理結果。route.ts 側で StripeWebhookEvent.processedAt の更新に使う。
 *
 * - `{ ok: true, action }`: 処理成功 (action は監査ログ用の説明文)
 * - `{ ok: true, action: 'ignored', reason }`: 既知だが副作用なしのイベント
 * - `{ ok: true, action: 'tenant_not_found' }`: テナント未紐付け (= Stripe Dashboard 操作等で先行受信)
 * - 失敗は throw (= route.ts で catch して errorMessage 記録 + 5xx 返却 → Stripe 再送)
 */
export type WebhookHandlerResult = {
  ok: true;
  action: string;
  tenantId?: string;
};

/**
 * Stripe Webhook イベントを type で分岐してハンドラを呼ぶ dispatcher。
 *
 * 呼出側 (route.ts) のフロー:
 *   1. signature 検証
 *   2. StripeWebhookEvent を id (= event.id) で upsert (= 冪等性確保)
 *   3. すでに processedAt != null なら 200 を即返却 (本関数を呼ばない)
 *   4. 本関数を呼出
 *   5. 成功なら processedAt = now を更新
 *   6. 失敗 (throw) なら errorMessage + retryCount を更新 → 5xx 返却
 */
export async function dispatchStripeWebhookEvent(
  event: Stripe.Event,
): Promise<WebhookHandlerResult> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
    case 'customer.subscription.deleted':
      return await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
    case 'invoice.created':
    case 'invoice.finalized':
      return await handleInvoiceCreatedOrFinalized(event.data.object as Stripe.Invoice);
    case 'invoice.paid':
      return await handleInvoicePaid(event.data.object as Stripe.Invoice);
    case 'invoice.payment_failed':
      return await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
    case 'payment_method.attached':
      return await handlePaymentMethodAttached(event.data.object as Stripe.PaymentMethod);
    case 'payment_method.detached':
      return await handlePaymentMethodDetached(event.data.object as Stripe.PaymentMethod);
    case 'payment_method.updated':
      return await handlePaymentMethodUpdated(event.data.object as Stripe.PaymentMethod);
    case 'customer.updated':
      return { ok: true, action: 'ignored', tenantId: undefined };
    default:
      // 未登録の event は安全側で無視 (= Stripe Dashboard で配信設定が増えても落ちない)
      return { ok: true, action: `ignored:${event.type}` };
  }
}

// ============================================================
// §1. Subscription 系
// ============================================================

/**
 * customer.subscription.created / updated を処理:
 *   - tenant.stripeSubscriptionId / Status / SubscriptionItem* を sync
 *   - status='past_due': autoSuspendScheduledAt = now + 3 日 (= STRIPE_BILLING.md §4.3)
 *   - status='active': autoSuspendScheduledAt = null、payment_delinquent で suspend 中なら resume
 */
async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription,
): Promise<WebhookHandlerResult> {
  const tenant = await resolveTenantBySubscription(subscription);
  if (tenant == null) {
    return { ok: true, action: 'tenant_not_found' };
  }

  const { haikuItemId, sonnetItemId, storageItemId } = extractSubscriptionItemIds(subscription);
  const now = new Date();

  // 自動 suspend スケジュールの判定
  let autoSuspendScheduledAt: Date | null | undefined = undefined; // undefined = 更新しない
  if (subscription.status === 'past_due') {
    autoSuspendScheduledAt = new Date(now.getTime() + AUTO_SUSPEND_GRACE_DAYS * 24 * 60 * 60 * 1000);
  } else if (subscription.status === 'active') {
    autoSuspendScheduledAt = null; // クリア
  }

  await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      stripeSubscriptionId: subscription.id,
      stripeSubscriptionStatus: subscription.status,
      stripeSubscriptionItemHaikuId: haikuItemId,
      stripeSubscriptionItemSonnetId: sonnetItemId,
      stripeSubscriptionItemStorageId: storageItemId,
      ...(autoSuspendScheduledAt !== undefined ? { autoSuspendScheduledAt } : {}),
    },
  });

  // active 復帰時に「payment_delinquent で suspend 中」なら自動 resume
  // (= Smart Retries 期間中の手動カード更新 → invoice.paid 経由で active になったケース)
  if (
    subscription.status === 'active' &&
    tenant.suspendedAt != null &&
    tenant.suspendReason === 'payment_delinquent'
  ) {
    await safeResumeTenant(tenant.id);
  }

  return { ok: true, action: `subscription_${subscription.status}`, tenantId: tenant.id };
}

/**
 * customer.subscription.deleted を処理:
 *   - tenant.stripeSubscriptionStatus = 'canceled'
 *   - autoSuspendScheduledAt はクリア (= 既にキャンセル済、追加 suspend は不要)
 *   - stripeSubscriptionId は監査用に残す (= 後日の照合用)
 */
async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
): Promise<WebhookHandlerResult> {
  const tenant = await resolveTenantBySubscription(subscription);
  if (tenant == null) {
    return { ok: true, action: 'tenant_not_found' };
  }

  await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      stripeSubscriptionStatus: 'canceled',
      autoSuspendScheduledAt: null,
    },
  });

  return { ok: true, action: 'subscription_canceled', tenantId: tenant.id };
}

// ============================================================
// §2. Invoice 系
// ============================================================

/**
 * invoice.created / invoice.finalized を処理:
 *   - BillingHistory を upsert (= 1 テナント × 1 月 1 件、key = tenantId + yearMonth)
 *   - status は既存値を維持 (= 既に 'paid' なら 'pending' に戻さない)
 *   - 金額は最新値で更新 (= finalized で確定値に差替)
 */
async function handleInvoiceCreatedOrFinalized(
  invoice: Stripe.Invoice,
): Promise<WebhookHandlerResult> {
  const tenant = await resolveTenantByInvoice(invoice);
  if (tenant == null) {
    return { ok: true, action: 'tenant_not_found' };
  }

  const yearMonth = formatInvoiceYearMonth(invoice, tenant.timezone);
  const amountJpy = invoice.subtotal ?? 0;
  const taxAmountJpy = invoice.tax ?? 0;
  const totalAmountJpy = invoice.total ?? 0;

  await prisma.billingHistory.upsert({
    where: {
      tenantId_yearMonth: { tenantId: tenant.id, yearMonth },
    },
    create: {
      tenantId: tenant.id,
      yearMonth,
      paymentMethod: 'credit_card',
      amountJpy,
      taxAmountJpy,
      totalAmountJpy,
      status: 'pending',
      stripeInvoiceId: invoice.id,
    },
    update: {
      amountJpy,
      taxAmountJpy,
      totalAmountJpy,
      stripeInvoiceId: invoice.id,
      // status は既存値を維持 (= 'paid' / 'refunded' を 'pending' に戻さない)
    },
  });

  return { ok: true, action: `invoice_${invoice.status}`, tenantId: tenant.id };
}

/**
 * invoice.paid を処理:
 *   - BillingHistory.status = 'paid', paidAt = now
 *   - payment_delinquent で suspend 中なら自動 resume (= STRIPE_BILLING.md §9.2)
 */
async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<WebhookHandlerResult> {
  const tenant = await resolveTenantByInvoice(invoice);
  if (tenant == null) {
    return { ok: true, action: 'tenant_not_found' };
  }

  const yearMonth = formatInvoiceYearMonth(invoice, tenant.timezone);
  const amountJpy = invoice.subtotal ?? 0;
  const taxAmountJpy = invoice.tax ?? 0;
  const totalAmountJpy = invoice.total ?? 0;
  const paidAt = invoice.status_transitions?.paid_at != null
    ? new Date(invoice.status_transitions.paid_at * 1000)
    : new Date();

  await prisma.billingHistory.upsert({
    where: {
      tenantId_yearMonth: { tenantId: tenant.id, yearMonth },
    },
    create: {
      tenantId: tenant.id,
      yearMonth,
      paymentMethod: 'credit_card',
      amountJpy,
      taxAmountJpy,
      totalAmountJpy,
      status: 'paid',
      stripeInvoiceId: invoice.id,
      paidAt,
    },
    update: {
      amountJpy,
      taxAmountJpy,
      totalAmountJpy,
      status: 'paid',
      stripeInvoiceId: invoice.id,
      paidAt,
      failureReason: null,
    },
  });

  // payment_delinquent で suspend 中なら resume (= STRIPE_BILLING.md §9.2)
  if (tenant.suspendedAt != null && tenant.suspendReason === 'payment_delinquent') {
    await safeResumeTenant(tenant.id);
  }

  return { ok: true, action: 'invoice_paid', tenantId: tenant.id };
}

/**
 * invoice.payment_failed を処理:
 *   - BillingHistory.status = 'failed', retryCount++, failureReason 保存
 *   - 自動 suspend は customer.subscription.updated (status=past_due) 側で処理 (= 二重実行回避)
 */
async function handleInvoicePaymentFailed(
  invoice: Stripe.Invoice,
): Promise<WebhookHandlerResult> {
  const tenant = await resolveTenantByInvoice(invoice);
  if (tenant == null) {
    return { ok: true, action: 'tenant_not_found' };
  }

  const yearMonth = formatInvoiceYearMonth(invoice, tenant.timezone);
  const amountJpy = invoice.subtotal ?? 0;
  const taxAmountJpy = invoice.tax ?? 0;
  const totalAmountJpy = invoice.total ?? 0;
  const failureReason = invoice.last_finalization_error?.code ?? 'payment_failed';

  await prisma.billingHistory.upsert({
    where: {
      tenantId_yearMonth: { tenantId: tenant.id, yearMonth },
    },
    create: {
      tenantId: tenant.id,
      yearMonth,
      paymentMethod: 'credit_card',
      amountJpy,
      taxAmountJpy,
      totalAmountJpy,
      status: 'failed',
      stripeInvoiceId: invoice.id,
      failureReason,
      retryCount: 1,
    },
    update: {
      amountJpy,
      taxAmountJpy,
      totalAmountJpy,
      status: 'failed',
      stripeInvoiceId: invoice.id,
      failureReason,
      retryCount: { increment: 1 },
    },
  });

  return { ok: true, action: 'invoice_payment_failed', tenantId: tenant.id };
}

// ============================================================
// §3. PaymentMethod 系
// ============================================================

/**
 * payment_method.attached を処理:
 *   - tenant.stripeDefaultPaymentMethodId を pm.id で更新 (= 初回登録 / 再登録)
 *   - cardVerificationStatus は触らない (= setup/complete ハンドラで検証 + 設定する)
 */
async function handlePaymentMethodAttached(
  pm: Stripe.PaymentMethod,
): Promise<WebhookHandlerResult> {
  const tenant = await resolveTenantByPaymentMethod(pm);
  if (tenant == null) {
    return { ok: true, action: 'tenant_not_found' };
  }

  await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      stripeDefaultPaymentMethodId: pm.id,
    },
  });

  return { ok: true, action: 'payment_method_attached', tenantId: tenant.id };
}

/**
 * payment_method.detached を処理:
 *   - tenant.stripeDefaultPaymentMethodId が detach 対象と一致するならクリア
 *   - cardVerificationStatus = 'never_verified' (= 再登録待ち)
 */
async function handlePaymentMethodDetached(
  pm: Stripe.PaymentMethod,
): Promise<WebhookHandlerResult> {
  const tenant = await resolveTenantByPaymentMethod(pm);
  if (tenant == null) {
    return { ok: true, action: 'tenant_not_found' };
  }

  if (tenant.stripeDefaultPaymentMethodId !== pm.id) {
    // 別の PaymentMethod が detach された (= デフォルト以外、無視)
    return { ok: true, action: 'payment_method_detached_non_default', tenantId: tenant.id };
  }

  await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      stripeDefaultPaymentMethodId: null,
      cardVerificationStatus: 'never_verified',
    },
  });

  return { ok: true, action: 'payment_method_detached', tenantId: tenant.id };
}

/**
 * payment_method.updated を処理 (= カード期限変更等):
 *   - cardVerificationStatus = 'never_verified' に戻す (= 次回プラン変更時 / 月初 cron で再検証)
 *   - cardLastVerifiedAt も null に戻す (= 古い検証成功時刻が新カードに引き継がれないように)
 */
async function handlePaymentMethodUpdated(
  pm: Stripe.PaymentMethod,
): Promise<WebhookHandlerResult> {
  const tenant = await resolveTenantByPaymentMethod(pm);
  if (tenant == null) {
    return { ok: true, action: 'tenant_not_found' };
  }

  if (tenant.stripeDefaultPaymentMethodId !== pm.id) {
    // デフォルト以外の PaymentMethod 更新は無視 (= 副作用なし)
    return { ok: true, action: 'payment_method_updated_non_default', tenantId: tenant.id };
  }

  await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      cardVerificationStatus: 'never_verified',
      cardLastVerifiedAt: null,
    },
  });

  return { ok: true, action: 'payment_method_updated', tenantId: tenant.id };
}

// ============================================================
// 内部ヘルパ
// ============================================================

type ResolvedTenant = {
  id: string;
  timezone: string;
  suspendedAt: Date | null;
  suspendReason: string | null;
  stripeDefaultPaymentMethodId: string | null;
};

const TENANT_RESOLVE_SELECT = {
  id: true,
  timezone: true,
  suspendedAt: true,
  suspendReason: true,
  stripeDefaultPaymentMethodId: true,
} as const;

/**
 * Subscription からテナントを解決:
 *   1. subscription.metadata.tenantId (= 作成時に埋めている)
 *   2. tenant.stripeSubscriptionId == subscription.id
 *   3. tenant.stripeCustomerId == subscription.customer
 *
 * PR-V7 (2026-05-19): すべての検索条件に `deletedAt: null` を追加。
 *   論理削除済テナントへの Webhook 配信 (= 解約直後の遅延 event 等) で削除済 DB が更新されるのを防ぐ。
 *   削除済テナント宛て event は `tenant_not_found` (= 200 OK) として無害化される。
 */
async function resolveTenantBySubscription(
  subscription: Stripe.Subscription,
): Promise<ResolvedTenant | null> {
  const metadataTenantId = subscription.metadata?.['tenantId'];
  if (metadataTenantId != null && metadataTenantId.length > 0) {
    const tenant = await prisma.tenant.findFirst({
      where: { id: metadataTenantId, deletedAt: null },
      select: TENANT_RESOLVE_SELECT,
    });
    if (tenant != null) return tenant;
  }

  const bySubId = await prisma.tenant.findFirst({
    where: { stripeSubscriptionId: subscription.id, deletedAt: null },
    select: TENANT_RESOLVE_SELECT,
  });
  if (bySubId != null) return bySubId;

  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer.id;
  return await prisma.tenant.findFirst({
    where: { stripeCustomerId: customerId, deletedAt: null },
    select: TENANT_RESOLVE_SELECT,
  });
}

/**
 * Invoice からテナントを解決:
 *   1. invoice.subscription_details.metadata.tenantId
 *   2. tenant.stripeCustomerId == invoice.customer
 *
 * PR-V7 (2026-05-19): すべての検索条件に `deletedAt: null` を追加。理由は同上。
 */
async function resolveTenantByInvoice(invoice: Stripe.Invoice): Promise<ResolvedTenant | null> {
  // Subscription 経由のメタデータ (= Stripe が subscription の metadata を invoice に転載)
  const metadataTenantId = invoice.subscription_details?.metadata?.['tenantId'];
  if (metadataTenantId != null && metadataTenantId.length > 0) {
    const tenant = await prisma.tenant.findFirst({
      where: { id: metadataTenantId, deletedAt: null },
      select: TENANT_RESOLVE_SELECT,
    });
    if (tenant != null) return tenant;
  }

  if (invoice.customer == null) return null;
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer.id;
  return await prisma.tenant.findFirst({
    where: { stripeCustomerId: customerId, deletedAt: null },
    select: TENANT_RESOLVE_SELECT,
  });
}

/**
 * PaymentMethod からテナントを解決:
 *   - pm.customer 経由でテナント逆引き (= 必ず Customer attached 後に発火する前提)
 *
 * PR-V7 (2026-05-19): 検索条件に `deletedAt: null` を追加。理由は同上。
 */
async function resolveTenantByPaymentMethod(
  pm: Stripe.PaymentMethod,
): Promise<ResolvedTenant | null> {
  if (pm.customer == null) return null;
  const customerId = typeof pm.customer === 'string' ? pm.customer : pm.customer.id;
  return await prisma.tenant.findFirst({
    where: { stripeCustomerId: customerId, deletedAt: null },
    select: TENANT_RESOLVE_SELECT,
  });
}

/**
 * Subscription Item の Price ID と Tenant の subscriptionItemId* を突合せて
 * haiku / sonnet / storage のそれぞれを抽出。
 *
 * Stripe の `subscription.items.data` は items の配列で、各 item の `price.id` と
 * 環境変数 (= STRIPE_PRICE_*) を比較して識別する。
 */
function extractSubscriptionItemIds(subscription: Stripe.Subscription): {
  haikuItemId: string | null;
  sonnetItemId: string | null;
  storageItemId: string | null;
} {
  const haikuPriceId = process.env['STRIPE_PRICE_HAIKU'];
  const sonnetPriceId = process.env['STRIPE_PRICE_SONNET'];
  const storagePlusPriceId = process.env['STRIPE_PRICE_STORAGE_PLUS'];
  const storageProPriceId = process.env['STRIPE_PRICE_STORAGE_PRO'];

  let haikuItemId: string | null = null;
  let sonnetItemId: string | null = null;
  let storageItemId: string | null = null;

  for (const item of subscription.items.data) {
    const priceId = item.price.id;
    if (priceId === haikuPriceId) haikuItemId = item.id;
    else if (priceId === sonnetPriceId) sonnetItemId = item.id;
    else if (priceId === storagePlusPriceId || priceId === storageProPriceId) {
      storageItemId = item.id;
    }
  }

  return { haikuItemId, sonnetItemId, storageItemId };
}

/**
 * Invoice から請求対象月 ("YYYY-MM") をテナントのタイムゾーンで生成。
 *
 * - `invoice.period_end` (Unix 秒) を Date に変換し、テナント TZ で「年-月」を組み立てる
 * - 月末請求が翌日 00:00 UTC に確定するケースでも JST ベースで正しい月にマップされる
 * - period_end が未設定なら `invoice.created` をフォールバックに使う
 */
function formatInvoiceYearMonth(invoice: Stripe.Invoice, timezone: string): string {
  const unixSec = invoice.period_end ?? invoice.created;
  const date = new Date(unixSec * 1000);
  // Intl.DateTimeFormat で year / month を tenant TZ で抽出
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  return `${year}-${month}`;
}

/**
 * resumeTenant を安全に呼出 (= 既に解除済 / 削除済 etc. のエラーは握り潰す)。
 *
 * - 自動 resume は「ベストエフォート」: 既に手動で resume 済 / 削除済テナントには副作用なしで終わる
 * - 別の suspendReason ('tos_violation' 等) で停止中なら resume しない (= resumeTenant は理由問わず解除するため、ここでは呼ぶ前提が成立する場合のみ)
 */
async function safeResumeTenant(tenantId: string): Promise<void> {
  try {
    await resumeTenant(tenantId, getSystemUserId());
  } catch (e) {
    // NOT_SUSPENDED / TENANT_DELETED 等は無視 (= Webhook の冪等性として正常)
    if (e instanceof Error && /NOT_SUSPENDED|TENANT_DELETED|TENANT_NOT_FOUND/.test(e.message)) {
      return;
    }
    throw e;
  }
}

// テスト容易性のため内部関数も export
export {
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoiceCreatedOrFinalized,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handlePaymentMethodAttached,
  handlePaymentMethodDetached,
  handlePaymentMethodUpdated,
  extractSubscriptionItemIds,
  formatInvoiceYearMonth,
};
