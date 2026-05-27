/**
 * stripe-webhook-handlers.service の単体テスト (PR-S4 / 2026-05-14)
 *
 * 検証観点 (STRIPE_BILLING.md §3.2 / §4.2-4.3 / §9.2):
 *   1. dispatchStripeWebhookEvent: 全 event type の分岐 + 未知 event の無視
 *   2. handleSubscriptionUpdated: status='past_due' → autoSuspendScheduledAt セット、
 *      status='active' → クリア + payment_delinquent suspend なら resume
 *   3. handleSubscriptionDeleted: stripeSubscriptionStatus = 'canceled'
 *   4. handleInvoicePaid: BillingHistory.status='paid'、suspend 解除
 *   5. handleInvoicePaymentFailed: retryCount++, failureReason
 *   6. handlePaymentMethod*: attached → セット、detached/updated → 検証ステータス変更
 *   7. テナント未紐付け event (metadata なし + customerId 不一致) は tenant_not_found で正常終了
 *   8. extractSubscriptionItemIds: Price ID マッチング
 *   9. formatInvoiceYearMonth: タイムゾーン依存の月境界
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Prisma モック
vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    billingHistory: {
      upsert: vi.fn(),
    },
  },
}));

// Stripe lib モック
vi.mock('@/lib/stripe', () => ({
  getSystemUserId: () => 'system-user-uuid',
}));

// super-admin.service モック (resumeTenant)
const mockResumeTenant = vi.fn();
vi.mock('@/services/super-admin.service', () => ({
  resumeTenant: (tenantId: string, performerId: string) => mockResumeTenant(tenantId, performerId),
}));

import { prisma } from '@/lib/db';
import {
  dispatchStripeWebhookEvent,
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
} from './stripe-webhook-handlers.service';
import type Stripe from 'stripe';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'cus_test_123';
const SUBSCRIPTION_ID = 'sub_test_123';

function buildTenant(overrides: Partial<{ suspendedAt: Date | null; suspendReason: string | null; stripeDefaultPaymentMethodId: string | null }> = {}) {
  return {
    id: TENANT_ID,
    timezone: 'Asia/Tokyo',
    suspendedAt: null,
    suspendReason: null,
    stripeDefaultPaymentMethodId: null,
    ...overrides,
  };
}

function buildSubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: SUBSCRIPTION_ID,
    customer: CUSTOMER_ID,
    status: 'active',
    metadata: { tenantId: TENANT_ID },
    items: {
      data: [
        { id: 'si_haiku', price: { id: 'price_haiku_test' } },
        { id: 'si_sonnet', price: { id: 'price_sonnet_test' } },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function buildInvoice(overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return {
    id: 'in_test_123',
    customer: CUSTOMER_ID,
    status: 'open',
    subtotal: 10_000,
    tax: 1_000,
    total: 11_000,
    period_end: 1735603200, // 2024-12-31 00:00 UTC
    created: 1735603200,
    subscription_details: { metadata: { tenantId: TENANT_ID } },
    status_transitions: {},
    last_finalization_error: null,
    ...overrides,
  } as unknown as Stripe.Invoice;
}

function buildPaymentMethod(overrides: Partial<Stripe.PaymentMethod> = {}): Stripe.PaymentMethod {
  return {
    id: 'pm_test_123',
    customer: CUSTOMER_ID,
    type: 'card',
    ...overrides,
  } as unknown as Stripe.PaymentMethod;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: env vars for extractSubscriptionItemIds
  // chore/storage-addon-backend-removal (2026-05-26): STRIPE_PRICE_STORAGE_PLUS / PRO は撤去済
  process.env['STRIPE_PRICE_HAIKU'] = 'price_haiku_test';
  process.env['STRIPE_PRICE_SONNET'] = 'price_sonnet_test';
});

// ============================================================
// dispatchStripeWebhookEvent: event type の分岐
// ============================================================

describe('dispatchStripeWebhookEvent', () => {
  it('未知の event type は ignored:<type> を返す (落とさない)', async () => {
    const event = {
      id: 'evt_unknown',
      type: 'unknown.event.type',
      data: { object: {} },
    } as unknown as Stripe.Event;
    const result = await dispatchStripeWebhookEvent(event);
    expect(result.ok).toBe(true);
    expect(result.action).toBe('ignored:unknown.event.type');
  });

  it('customer.updated は副作用なしの ignored を返す', async () => {
    const event = {
      id: 'evt_cust_upd',
      type: 'customer.updated',
      data: { object: { id: CUSTOMER_ID } },
    } as unknown as Stripe.Event;
    const result = await dispatchStripeWebhookEvent(event);
    expect(result.ok).toBe(true);
    expect(result.action).toBe('ignored');
  });

  it('customer.subscription.created を handleSubscriptionUpdated に dispatch する', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(buildTenant() as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);
    const event = {
      id: 'evt_sub_created',
      type: 'customer.subscription.created',
      data: { object: buildSubscription() },
    } as unknown as Stripe.Event;
    const result = await dispatchStripeWebhookEvent(event);
    expect(result.action).toBe('subscription_active');
    expect(prisma.tenant.update).toHaveBeenCalled();
  });
});

// ============================================================
// handleSubscriptionUpdated
// ============================================================

describe('handleSubscriptionUpdated', () => {
  it('status=past_due → autoSuspendScheduledAt が now+3日にセットされる', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(buildTenant() as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const sub = buildSubscription({ status: 'past_due' });
    const result = await handleSubscriptionUpdated(sub);

    expect(result.ok).toBe(true);
    expect(result.action).toBe('subscription_past_due');

    const updateCall = vi.mocked(prisma.tenant.update).mock.calls[0]?.[0];
    expect(updateCall?.data.stripeSubscriptionStatus).toBe('past_due');
    const scheduledAt = updateCall?.data.autoSuspendScheduledAt as Date;
    expect(scheduledAt).toBeInstanceOf(Date);
    const deltaMs = scheduledAt.getTime() - Date.now();
    // 約 3 日 (= 2.9〜3.1 日の範囲で許容)
    expect(deltaMs).toBeGreaterThan(2.9 * 24 * 60 * 60 * 1000);
    expect(deltaMs).toBeLessThan(3.1 * 24 * 60 * 60 * 1000);
  });

  it('status=active → autoSuspendScheduledAt が null にクリアされる', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(buildTenant() as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const sub = buildSubscription({ status: 'active' });
    await handleSubscriptionUpdated(sub);

    const updateCall = vi.mocked(prisma.tenant.update).mock.calls[0]?.[0];
    expect(updateCall?.data.autoSuspendScheduledAt).toBeNull();
  });

  it('status=active かつ payment_delinquent で suspend 中なら resumeTenant が呼ばれる', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      buildTenant({ suspendedAt: new Date(), suspendReason: 'payment_delinquent' }) as never,
    );
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);
    mockResumeTenant.mockResolvedValue({});

    await handleSubscriptionUpdated(buildSubscription({ status: 'active' }));

    expect(mockResumeTenant).toHaveBeenCalledWith(TENANT_ID, 'system-user-uuid');
  });

  it('status=active でも別 reason (tos_violation) で suspend 中なら resumeTenant は呼ばれない', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      buildTenant({ suspendedAt: new Date(), suspendReason: 'tos_violation' }) as never,
    );
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    await handleSubscriptionUpdated(buildSubscription({ status: 'active' }));

    expect(mockResumeTenant).not.toHaveBeenCalled();
  });

  it('テナント未紐付け (metadata なし + customerId 不一致) → tenant_not_found を返す', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(null);

    const sub = buildSubscription({ metadata: {} });
    const result = await handleSubscriptionUpdated(sub);

    expect(result.action).toBe('tenant_not_found');
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  // PR-V7 (2026-05-19): #4 deletedAt フィルタ検証
  it('論理削除済テナント (= findFirst が null 返却) には webhook を反映しない', async () => {
    // 全 lookup (metadata.tenantId / stripeSubscriptionId / stripeCustomerId) で deletedAt: null
    // フィルタにより null が返るので tenant_not_found 扱い
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(null);

    const sub = buildSubscription({ status: 'past_due' });
    const result = await handleSubscriptionUpdated(sub);

    expect(result.action).toBe('tenant_not_found');
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    // findFirst 呼出時に where に deletedAt: null が含まれることを検証
    const firstCall = vi.mocked(prisma.tenant.findFirst).mock.calls[0]?.[0];
    expect(firstCall?.where).toMatchObject({ deletedAt: null });
  });
});

// ============================================================
// handleSubscriptionDeleted
// ============================================================

describe('handleSubscriptionDeleted', () => {
  it('stripeSubscriptionStatus を canceled に更新する', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(buildTenant() as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const result = await handleSubscriptionDeleted(buildSubscription({ status: 'canceled' }));

    expect(result.action).toBe('subscription_canceled');
    const updateCall = vi.mocked(prisma.tenant.update).mock.calls[0]?.[0];
    expect(updateCall?.data.stripeSubscriptionStatus).toBe('canceled');
    expect(updateCall?.data.autoSuspendScheduledAt).toBeNull();
  });
});

// ============================================================
// handleInvoiceCreatedOrFinalized
// ============================================================

describe('handleInvoiceCreatedOrFinalized', () => {
  it('BillingHistory を upsert する (新規作成側)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(buildTenant() as never);
    vi.mocked(prisma.billingHistory.upsert).mockResolvedValue({} as never);

    const result = await handleInvoiceCreatedOrFinalized(buildInvoice({ status: 'open' }));

    expect(result.action).toBe('invoice_open');
    const call = vi.mocked(prisma.billingHistory.upsert).mock.calls[0]?.[0];
    expect(call?.create.tenantId).toBe(TENANT_ID);
    expect(call?.create.paymentMethod).toBe('credit_card');
    expect(call?.create.status).toBe('pending');
    expect(call?.create.amountJpy).toBe(10_000);
    expect(call?.create.taxAmountJpy).toBe(1_000);
    expect(call?.create.totalAmountJpy).toBe(11_000);
    // status は update side で touched しない (= 既存 'paid' を 'pending' に戻さない)
    expect(call?.update.status).toBeUndefined();
  });
});

// ============================================================
// handleInvoicePaid
// ============================================================

describe('handleInvoicePaid', () => {
  it('status=paid + paidAt をセットする', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(buildTenant() as never);
    vi.mocked(prisma.billingHistory.upsert).mockResolvedValue({} as never);

    const invoice = buildInvoice({
      status: 'paid',
      status_transitions: { paid_at: 1735603200 } as unknown as Stripe.Invoice['status_transitions'],
    });
    const result = await handleInvoicePaid(invoice);

    expect(result.action).toBe('invoice_paid');
    const call = vi.mocked(prisma.billingHistory.upsert).mock.calls[0]?.[0];
    expect(call?.update.status).toBe('paid');
    expect(call?.update.paidAt).toBeInstanceOf(Date);
    expect(call?.update.failureReason).toBeNull();
  });

  it('payment_delinquent で suspend 中なら resumeTenant が呼ばれる', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      buildTenant({ suspendedAt: new Date(), suspendReason: 'payment_delinquent' }) as never,
    );
    vi.mocked(prisma.billingHistory.upsert).mockResolvedValue({} as never);
    mockResumeTenant.mockResolvedValue({});

    await handleInvoicePaid(buildInvoice());

    expect(mockResumeTenant).toHaveBeenCalledWith(TENANT_ID, 'system-user-uuid');
  });

  it('resumeTenant が NOT_SUSPENDED でも throw しない (= 冪等性)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      buildTenant({ suspendedAt: new Date(), suspendReason: 'payment_delinquent' }) as never,
    );
    vi.mocked(prisma.billingHistory.upsert).mockResolvedValue({} as never);
    mockResumeTenant.mockRejectedValue(new Error('NOT_SUSPENDED'));

    await expect(handleInvoicePaid(buildInvoice())).resolves.toMatchObject({
      action: 'invoice_paid',
    });
  });
});

// ============================================================
// handleInvoicePaymentFailed
// ============================================================

describe('handleInvoicePaymentFailed', () => {
  it('status=failed + retryCount=1 + failureReason を upsert.create で設定', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(buildTenant() as never);
    vi.mocked(prisma.billingHistory.upsert).mockResolvedValue({} as never);

    const invoice = buildInvoice({
      last_finalization_error: { code: 'card_declined' } as unknown as Stripe.Invoice['last_finalization_error'],
    });
    const result = await handleInvoicePaymentFailed(invoice);

    expect(result.action).toBe('invoice_payment_failed');
    const call = vi.mocked(prisma.billingHistory.upsert).mock.calls[0]?.[0];
    expect(call?.create.status).toBe('failed');
    expect(call?.create.failureReason).toBe('card_declined');
    expect(call?.create.retryCount).toBe(1);
    // update 側は increment
    expect(call?.update.retryCount).toEqual({ increment: 1 });
  });
});

// ============================================================
// handlePaymentMethodAttached / Detached / Updated
// ============================================================

describe('handlePaymentMethodAttached', () => {
  it('tenant.stripeDefaultPaymentMethodId を pm.id で更新する', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(buildTenant() as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const result = await handlePaymentMethodAttached(buildPaymentMethod({ id: 'pm_new' }));

    expect(result.action).toBe('payment_method_attached');
    const call = vi.mocked(prisma.tenant.update).mock.calls[0]?.[0];
    expect(call?.data.stripeDefaultPaymentMethodId).toBe('pm_new');
  });
});

describe('handlePaymentMethodDetached', () => {
  it('default PM が detach された → クリア + cardVerificationStatus = never_verified', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      buildTenant({ stripeDefaultPaymentMethodId: 'pm_test_123' }) as never,
    );
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const result = await handlePaymentMethodDetached(buildPaymentMethod({ id: 'pm_test_123' }));

    expect(result.action).toBe('payment_method_detached');
    const call = vi.mocked(prisma.tenant.update).mock.calls[0]?.[0];
    expect(call?.data.stripeDefaultPaymentMethodId).toBeNull();
    expect(call?.data.cardVerificationStatus).toBe('never_verified');
  });

  it('default 以外の PM が detach された → 副作用なし', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      buildTenant({ stripeDefaultPaymentMethodId: 'pm_default' }) as never,
    );

    const result = await handlePaymentMethodDetached(buildPaymentMethod({ id: 'pm_other' }));

    expect(result.action).toBe('payment_method_detached_non_default');
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });
});

describe('handlePaymentMethodUpdated', () => {
  it('default PM のカード情報変更 → cardVerificationStatus を never_verified に戻す', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(
      buildTenant({ stripeDefaultPaymentMethodId: 'pm_test_123' }) as never,
    );
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const result = await handlePaymentMethodUpdated(buildPaymentMethod({ id: 'pm_test_123' }));

    expect(result.action).toBe('payment_method_updated');
    const call = vi.mocked(prisma.tenant.update).mock.calls[0]?.[0];
    expect(call?.data.cardVerificationStatus).toBe('never_verified');
    expect(call?.data.cardLastVerifiedAt).toBeNull();
  });
});

// ============================================================
// extractSubscriptionItemIds
// ============================================================

describe('extractSubscriptionItemIds', () => {
  it('Haiku / Sonnet の SubscriptionItem ID を抽出する', () => {
    // chore/storage-addon-backend-removal (2026-05-26): Storage item テストは削除済
    // (Storage add-on は ADR-0020/0021 で完全従量課金化により撤去)
    const sub = buildSubscription({
      items: {
        data: [
          { id: 'si_haiku', price: { id: 'price_haiku_test' } },
          { id: 'si_sonnet', price: { id: 'price_sonnet_test' } },
        ],
      },
    } as unknown as Partial<Stripe.Subscription>);

    const result = extractSubscriptionItemIds(sub);
    expect(result.haikuItemId).toBe('si_haiku');
    expect(result.sonnetItemId).toBe('si_sonnet');
  });

  it('未知の Price ID は null を返す', () => {
    const sub = buildSubscription({
      items: {
        data: [{ id: 'si_unknown', price: { id: 'price_unknown' } }],
      },
    } as unknown as Partial<Stripe.Subscription>);

    const result = extractSubscriptionItemIds(sub);
    expect(result.haikuItemId).toBeNull();
    expect(result.sonnetItemId).toBeNull();
  });
});

// ============================================================
// formatInvoiceYearMonth
// ============================================================

describe('formatInvoiceYearMonth', () => {
  it('UTC 2024-12-31 21:00 を Asia/Tokyo TZ で 2025-01 (= JST 1/1 06:00) として返す', () => {
    // 2024-12-31 21:00 UTC = 2025-01-01 06:00 JST
    const invoice = buildInvoice({ period_end: 1735678800 });
    const result = formatInvoiceYearMonth(invoice, 'Asia/Tokyo');
    expect(result).toBe('2025-01');
  });

  it('UTC 2024-12-31 23:00 を UTC TZ で 2024-12 として返す', () => {
    const invoice = buildInvoice({ period_end: 1735686000 });
    const result = formatInvoiceYearMonth(invoice, 'UTC');
    expect(result).toBe('2024-12');
  });

  it('period_end が undefined のとき created にフォールバック', () => {
    const invoice = buildInvoice({ period_end: undefined as unknown as number, created: 1735603200 });
    const result = formatInvoiceYearMonth(invoice, 'Asia/Tokyo');
    expect(result).toBe('2024-12'); // 2024-12-31 09:00 JST
  });
});
