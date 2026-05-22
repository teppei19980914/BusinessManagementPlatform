/**
 * stripe-billing.service の単体テスト (PR-S2 / 2026-05-14)
 *
 * 検証観点 (詳細設計 §A-1 / §A-2 / §4 等):
 *   1. createOrGetStripeCustomer: 既存 Customer 流用、新規作成、idempotency_key、テナント不在
 *   2. createCheckoutSessionForCardSetup: success/cancel URL 構築、Customer 自動作成
 *   3. createCustomerPortalSession: Customer 未登録時のエラー
 *   4. verifyTenantCard: 期限切れ判定、$0 SetupIntent、検証成功時 DB 更新
 *   5. createSubscriptionForTenant: Subscription Items (haiku/sonnet/storage), billing_cycle_anchor, idempotency
 *   6. reportUsage: Usage Record 送信、idempotency_key
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Prisma モック
vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findUnique: vi.fn(),
      // PR-V7 横展開: 多くのヘルパは findUnique → findFirst (deletedAt: null) に変更されたため両方 mock 必要
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

// Stripe SDK のモック (= getStripe() が返す client をモック化)
const mockStripeClient = {
  customers: {
    create: vi.fn(),
    retrieve: vi.fn(),
  },
  checkout: {
    sessions: {
      create: vi.fn(),
    },
  },
  billingPortal: {
    sessions: {
      create: vi.fn(),
    },
  },
  paymentMethods: {
    retrieve: vi.fn(),
  },
  setupIntents: {
    create: vi.fn(),
  },
  subscriptions: {
    create: vi.fn(),
    // PR-V7 #1 (2026-05-19): Subscription キャンセル (= deleteTenant / revert from credit_card)
    cancel: vi.fn(),
  },
  subscriptionItems: {
    createUsageRecord: vi.fn(),
    // PR-V7 #2 (2026-05-19): Storage プラン変更時の Item 同期
    create: vi.fn(),
    update: vi.fn(),
    del: vi.fn(),
  },
  // PR-V8 (2026-05-19): Meter API への移行で reportUsage の送信先が変更
  billing: {
    meterEvents: {
      create: vi.fn(),
    },
  },
};

vi.mock('@/lib/stripe', () => ({
  getStripe: () => mockStripeClient,
  getStripePriceConfig: () => ({
    haiku: 'price_haiku_test',
    sonnet: 'price_sonnet_test',
    storagePlus: 'price_storage_plus_test',
    storagePro: 'price_storage_pro_test',
  }),
  getStoragePriceId: (plan: string) => {
    if (plan === 'standard') return null;
    if (plan === 'plus') return 'price_storage_plus_test';
    if (plan === 'pro_storage') return 'price_storage_pro_test';
    return null;
  },
  // PR-V8 (2026-05-19): Meter API event name 定数
  STRIPE_METER_EVENT_NAMES: {
    haiku: 'tasukiba_haiku_api_call',
    sonnet: 'tasukiba_sonnet_api_call',
  },
}));

import { prisma } from '@/lib/db';
import {
  createOrGetStripeCustomer,
  createCheckoutSessionForCardSetup,
  createCustomerPortalSession,
  verifyTenantCard,
  createSubscriptionForTenant,
  reportUsage,
  // PR-V7 #1 (2026-05-19)
  cancelTenantStripeSubscription,
  // PR-V7 #2 (2026-05-19)
  syncStorageAddonToStripe,
} from './stripe-billing.service';

const TENANT_ID = '00000000-0000-0000-0000-000000000abc';

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// §1. createOrGetStripeCustomer
// ============================================================

describe('createOrGetStripeCustomer', () => {
  it('既存 Customer がある場合は再利用 (= API 呼出は retrieve のみ)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: TENANT_ID,
      name: 'TestCorp',
      stripeCustomerId: 'cus_existing_123',
      billingContactEmail: 'a@b.com',
      billingCompanyName: 'TestCorp',
      billingContactName: '担当',
    } as never);
    mockStripeClient.customers.retrieve.mockResolvedValueOnce({
      id: 'cus_existing_123',
      object: 'customer',
    });

    const result = await createOrGetStripeCustomer(TENANT_ID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe('cus_existing_123');
    expect(mockStripeClient.customers.retrieve).toHaveBeenCalledWith('cus_existing_123');
    expect(mockStripeClient.customers.create).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('未登録テナントは新規 Customer 作成 + DB 保存', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: TENANT_ID,
      name: 'NewTenant',
      stripeCustomerId: null,
      billingContactEmail: 'new@x.com',
      billingCompanyName: 'NewTenant Inc',
      billingContactName: '担当者',
    } as never);
    mockStripeClient.customers.create.mockResolvedValueOnce({
      id: 'cus_new_456',
      object: 'customer',
    });

    const result = await createOrGetStripeCustomer(TENANT_ID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe('cus_new_456');

    // idempotency_key が tenantId ベースで一意
    const createCall = mockStripeClient.customers.create.mock.calls[0]!;
    expect(createCall[0]).toMatchObject({
      name: 'NewTenant Inc',
      email: 'new@x.com',
      metadata: { tenantId: TENANT_ID },
    });
    expect(createCall[1]).toMatchObject({
      idempotencyKey: `customer:create:${TENANT_ID}`,
    });

    // DB に Customer ID 保存
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { stripeCustomerId: 'cus_new_456' },
    });
  });

  it('テナント不在は invalid_request 返却', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null);

    const result = await createOrGetStripeCustomer(TENANT_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid_request');
      expect(result.userMessage).toContain('テナントが見つかりません');
    }
    expect(mockStripeClient.customers.create).not.toHaveBeenCalled();
  });

  it('Customer 作成失敗時は DB 保存しない', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: TENANT_ID,
      name: 'T',
      stripeCustomerId: null,
      billingContactEmail: null,
      billingCompanyName: null,
      billingContactName: null,
    } as never);
    mockStripeClient.customers.create.mockRejectedValueOnce(new Error('Stripe network error'));

    const result = await createOrGetStripeCustomer(TENANT_ID);

    expect(result.ok).toBe(false);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });
});

// ============================================================
// §2. createCheckoutSessionForCardSetup
// ============================================================

describe('createCheckoutSessionForCardSetup', () => {
  it('成功時に Checkout Session URL を返す + success_url は complete ハンドラに向ける', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: TENANT_ID,
      name: 'T',
      stripeCustomerId: 'cus_xxx',
      billingContactEmail: null,
      billingCompanyName: null,
      billingContactName: null,
    } as never);
    mockStripeClient.customers.retrieve.mockResolvedValueOnce({ id: 'cus_xxx' });
    mockStripeClient.checkout.sessions.create.mockResolvedValueOnce({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    });

    const result = await createCheckoutSessionForCardSetup(
      TENANT_ID,
      'https://app.example/settings/tenant',
    );

    expect(result.ok).toBe(true);
    const params = mockStripeClient.checkout.sessions.create.mock.calls[0]![0]!;
    expect(params.mode).toBe('setup');
    expect(params.customer).toBe('cus_xxx');
    // success_url は complete ハンドラを指す (= Stripe が {CHECKOUT_SESSION_ID} を展開)
    expect(params.success_url).toContain('/api/tenants/me/billing/stripe/setup/complete');
    expect(params.success_url).toContain('{CHECKOUT_SESSION_ID}');
    expect(params.success_url).toContain('return_to=');
    // cancel_url は元の returnUrl + stripe_setup=canceled
    expect(params.cancel_url).toContain('stripe_setup=canceled');
    expect(params.locale).toBe('ja');
  });

  it('Customer 取得失敗時はそのまま伝播', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null);

    const result = await createCheckoutSessionForCardSetup(TENANT_ID, 'https://x.y');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_request');
    expect(mockStripeClient.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

// ============================================================
// §3. createCustomerPortalSession
// ============================================================

describe('createCustomerPortalSession', () => {
  it('成功時に Portal Session URL を返す', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      stripeCustomerId: 'cus_xxx',
    } as never);
    mockStripeClient.billingPortal.sessions.create.mockResolvedValueOnce({
      id: 'bps_123',
      url: 'https://billing.stripe.com/p/session/xxx',
    });

    const result = await createCustomerPortalSession(TENANT_ID, 'https://app.example/settings/tenant');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.url).toContain('billing.stripe.com');
    const params = mockStripeClient.billingPortal.sessions.create.mock.calls[0]![0]!;
    expect(params.customer).toBe('cus_xxx');
    expect(params.return_url).toContain('from=portal');
  });

  it('Customer 未登録なら invalid_request', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      stripeCustomerId: null,
    } as never);

    const result = await createCustomerPortalSession(TENANT_ID, 'https://x.y');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid_request');
      expect(result.userMessage).toContain('未登録');
    }
    expect(mockStripeClient.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('テナント不在も invalid_request', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null);

    const result = await createCustomerPortalSession(TENANT_ID, 'https://x.y');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_request');
  });
});

// ============================================================
// §4. verifyTenantCard
// ============================================================

describe('verifyTenantCard', () => {
  it('期限切れカード → status=expired (DB 更新、SetupIntent は呼ばない)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      stripeCustomerId: 'cus_xxx',
      stripeDefaultPaymentMethodId: 'pm_xxx',
    } as never);
    mockStripeClient.paymentMethods.retrieve.mockResolvedValueOnce({
      id: 'pm_xxx',
      card: {
        exp_year: 2020, // 過去
        exp_month: 12,
      },
    });

    const result = await verifyTenantCard(TENANT_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('expired');
      expect(result.value.failureReason).toBe('expired_card');
    }
    expect(mockStripeClient.setupIntents.create).not.toHaveBeenCalled();
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { cardVerificationStatus: 'expired' },
    });
  });

  it('有効期限内 + SetupIntent succeeded → status=valid (= 検証成功、DB 更新)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      stripeCustomerId: 'cus_xxx',
      stripeDefaultPaymentMethodId: 'pm_xxx',
    } as never);
    mockStripeClient.paymentMethods.retrieve.mockResolvedValueOnce({
      id: 'pm_xxx',
      card: {
        exp_year: 2099,
        exp_month: 12,
      },
    });
    mockStripeClient.setupIntents.create.mockResolvedValueOnce({
      id: 'seti_xxx',
      status: 'succeeded',
    });

    const result = await verifyTenantCard(TENANT_ID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('valid');
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: expect.objectContaining({
        cardLastVerifiedAt: expect.any(Date),
        cardVerificationStatus: 'valid',
      }),
    });
  });

  it('SetupIntent succeeded 以外の status → status=declined', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      stripeCustomerId: 'cus_xxx',
      stripeDefaultPaymentMethodId: 'pm_xxx',
    } as never);
    mockStripeClient.paymentMethods.retrieve.mockResolvedValueOnce({
      id: 'pm_xxx',
      card: { exp_year: 2099, exp_month: 12 },
    });
    mockStripeClient.setupIntents.create.mockResolvedValueOnce({
      id: 'seti_xxx',
      status: 'requires_action',
      last_setup_error: { code: 'authentication_required' },
    });

    const result = await verifyTenantCard(TENANT_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('declined');
      expect(result.value.failureReason).toBe('authentication_required');
    }
  });

  it('カード未登録なら invalid_request', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      stripeCustomerId: 'cus_xxx',
      stripeDefaultPaymentMethodId: null,
    } as never);

    const result = await verifyTenantCard(TENANT_ID);

    expect(result.ok).toBe(false);
    // PR #425 (2026-05-22): TypeScript narrow のため code 判定を if 内に組み込む
    //   (= StripeOperationResult union 全体では `detail` は invalid_request バリアントのみ)
    if (!result.ok && result.code === 'invalid_request') {
      expect(result.detail).toBe('card_not_registered');
    } else {
      throw new Error('expected invalid_request code');
    }
  });
});

// ============================================================
// §5. createSubscriptionForTenant
// ============================================================

describe('createSubscriptionForTenant', () => {
  it('Subscription Items: haiku + sonnet + storage Plus が含まれる', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      stripeCustomerId: 'cus_xxx',
    } as never);
    mockStripeClient.subscriptions.create.mockResolvedValueOnce({
      id: 'sub_xxx',
      status: 'active',
    });

    await createSubscriptionForTenant({
      tenantId: TENANT_ID,
      storageAddonPlan: 'plus',
      billingCycleAnchor: 1717200000,
      paymentMethodId: 'pm_xxx',
    });

    const params = mockStripeClient.subscriptions.create.mock.calls[0]![0]!;
    expect(params.customer).toBe('cus_xxx');
    expect(params.items).toEqual([
      { price: 'price_haiku_test' },
      { price: 'price_sonnet_test' },
      { price: 'price_storage_plus_test' },
    ]);
    expect(params.default_payment_method).toBe('pm_xxx');
    expect(params.automatic_tax).toEqual({ enabled: true });
    expect(params.proration_behavior).toBe('none');
    expect(params.billing_cycle_anchor).toBe(1717200000);
    expect(params.metadata).toEqual({ tenantId: TENANT_ID });

    // idempotency_key: tenantId ベース
    const opts = mockStripeClient.subscriptions.create.mock.calls[0]![1]!;
    expect(opts.idempotencyKey).toBe(`subscription:create:${TENANT_ID}`);
  });

  it('storage=standard なら storage Item は含めない (= ¥0、Subscription 不要)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      stripeCustomerId: 'cus_xxx',
    } as never);
    mockStripeClient.subscriptions.create.mockResolvedValueOnce({ id: 'sub_xxx' });

    await createSubscriptionForTenant({
      tenantId: TENANT_ID,
      storageAddonPlan: 'standard',
      billingCycleAnchor: null,
      paymentMethodId: 'pm_xxx',
    });

    const params = mockStripeClient.subscriptions.create.mock.calls[0]![0]!;
    expect(params.items).toEqual([
      { price: 'price_haiku_test' },
      { price: 'price_sonnet_test' },
    ]);
    // billing_cycle_anchor null なら指定しない
    expect(params.billing_cycle_anchor).toBeUndefined();
  });

  it('Customer 未登録なら invalid_request', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      stripeCustomerId: null,
    } as never);

    const result = await createSubscriptionForTenant({
      tenantId: TENANT_ID,
      storageAddonPlan: 'standard',
      billingCycleAnchor: null,
      paymentMethodId: 'pm_xxx',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_request');
    expect(mockStripeClient.subscriptions.create).not.toHaveBeenCalled();
  });
});

// ============================================================
// §6. reportUsage
// ============================================================

describe('reportUsage (PR-V8: Meter API)', () => {
  it('Meter event を送信 + identifier で重複防止', async () => {
    mockStripeClient.billing.meterEvents.create.mockResolvedValueOnce({
      identifier: 'usage:haiku:apicall-uuid-1',
    });

    const result = await reportUsage({
      stripeCustomerId: 'cus_xxx',
      callType: 'haiku',
      quantity: 1,
      occurredAt: new Date('2026-06-15T10:00:00Z'),
      apiCallLogId: 'apicall-uuid-1',
    });

    expect(result.ok).toBe(true);
    const call = mockStripeClient.billing.meterEvents.create.mock.calls[0]!;
    expect(call[0]).toEqual({
      event_name: 'tasukiba_haiku_api_call',
      payload: {
        stripe_customer_id: 'cus_xxx',
        value: '1',
      },
      identifier: 'usage:haiku:apicall-uuid-1',
      timestamp: Math.floor(new Date('2026-06-15T10:00:00Z').getTime() / 1000),
    });
  });

  it('callType=sonnet で event_name が tasukiba_sonnet_api_call', async () => {
    mockStripeClient.billing.meterEvents.create.mockResolvedValueOnce({ identifier: 'usage:sonnet:x' });

    await reportUsage({
      stripeCustomerId: 'cus_x',
      callType: 'sonnet',
      quantity: 1,
      occurredAt: new Date(),
      apiCallLogId: 'log-id',
    });

    const call = mockStripeClient.billing.meterEvents.create.mock.calls[0]!;
    expect((call[0] as { event_name: string }).event_name).toBe('tasukiba_sonnet_api_call');
  });

  it('quantity > 1 で bulk 操作対応 (= payload.value で文字列で渡る)', async () => {
    mockStripeClient.billing.meterEvents.create.mockResolvedValueOnce({ identifier: 'x' });

    await reportUsage({
      stripeCustomerId: 'cus_x',
      callType: 'sonnet',
      quantity: 5,
      occurredAt: new Date(),
      apiCallLogId: 'log-id',
    });

    const call = mockStripeClient.billing.meterEvents.create.mock.calls[0]!;
    expect((call[0] as { payload: { value: string } }).payload.value).toBe('5');
  });

  it('Stripe エラー時は Result.ok=false を伝播', async () => {
    mockStripeClient.billing.meterEvents.create.mockRejectedValueOnce(
      new Error('network error'),
    );

    const result = await reportUsage({
      stripeCustomerId: 'cus_x',
      callType: 'haiku',
      quantity: 1,
      occurredAt: new Date(),
      apiCallLogId: 'log-id',
    });

    expect(result.ok).toBe(false);
  });
});

// ============================================================
// §7. cancelTenantStripeSubscription (PR-V7 #1 / 2026-05-19)
// ============================================================

// cancelTenantStripeSubscription は deleteTenant から「テナント論理削除直後」に呼ばれるため、
// findFirst + deletedAt: null フィルタを付けると常に null 返却となり機能しなくなる。
// よって本ヘルパは findUnique のまま (= deletedAt 関係なくテナントを引く) という設計判断。
describe('cancelTenantStripeSubscription', () => {
  it('テナント不在 → ok=true + canceled=false + reason=tenant_not_found', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce(null);
    const result = await cancelTenantStripeSubscription(TENANT_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.canceled).toBe(false);
      expect(result.value.reason).toBe('tenant_not_found');
    }
    expect(mockStripeClient.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it('Subscription 未登録 → no-op (= 元から invoice 払い等)', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
      paymentMethod: 'invoice',
    } as never);
    const result = await cancelTenantStripeSubscription(TENANT_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reason).toBe('no_subscription');
    expect(mockStripeClient.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it('既に canceled → no-op (= Webhook で先に倒れた可能性)', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
      stripeSubscriptionId: 'sub_xxx',
      stripeSubscriptionStatus: 'canceled',
      paymentMethod: 'credit_card',
    } as never);
    const result = await cancelTenantStripeSubscription(TENANT_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reason).toBe('already_canceled');
    expect(mockStripeClient.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it('成功時: invoice_now: true + prorate: false で stripe.subscriptions.cancel を呼ぶ', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
      stripeSubscriptionId: 'sub_active_123',
      stripeSubscriptionStatus: 'active',
      paymentMethod: 'credit_card',
    } as never);
    mockStripeClient.subscriptions.cancel.mockResolvedValueOnce({
      id: 'sub_active_123',
      status: 'canceled',
    });

    const result = await cancelTenantStripeSubscription(TENANT_ID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.canceled).toBe(true);
    expect(mockStripeClient.subscriptions.cancel).toHaveBeenCalledWith('sub_active_123', {
      invoice_now: true,
      prorate: false,
    });
  });

  it('Stripe 側で既に canceled (invalid_request) → no-op として ok=true', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
      stripeSubscriptionId: 'sub_xxx',
      stripeSubscriptionStatus: 'active',
      paymentMethod: 'credit_card',
    } as never);
    const StripeImport = await import('stripe');
    mockStripeClient.subscriptions.cancel.mockRejectedValueOnce(
      new StripeImport.default.errors.StripeInvalidRequestError({
        message: 'This subscription has already been canceled',
        type: 'invalid_request_error',
      }),
    );

    const result = await cancelTenantStripeSubscription(TENANT_ID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reason).toBe('already_canceled_stripe_side');
  });

  it('Stripe API 失敗 (= connection error) → ok=false を伝播 (呼出側で auditLog 想定)', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
      stripeSubscriptionId: 'sub_xxx',
      stripeSubscriptionStatus: 'active',
      paymentMethod: 'credit_card',
    } as never);
    const StripeImport = await import('stripe');
    mockStripeClient.subscriptions.cancel.mockRejectedValueOnce(
      new StripeImport.default.errors.StripeConnectionError({
        message: 'Connection refused',
        // StripeConnectionError は RawErrorType に含まれない 'api_connection_error' を内部 type に持つが、
        // 互換性のためコンストラクタは raw 値を受けるので as never で型回避 (テスト目的のみ)
        type: 'api_connection_error' as never,
      }),
    );

    const result = await cancelTenantStripeSubscription(TENANT_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('connection');
  });
});

// ============================================================
// §8. syncStorageAddonToStripe (PR-V7 #2 / 2026-05-19)
// ============================================================

describe('syncStorageAddonToStripe', () => {
  it('paymentMethod=invoice (= 元から非 credit_card) → no-op', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      paymentMethod: 'invoice',
      stripeSubscriptionId: null,
      stripeSubscriptionItemStorageId: null,
    } as never);

    const result = await syncStorageAddonToStripe(TENANT_ID, 'standard', 'plus');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.action).toBe('noop');
    expect(mockStripeClient.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it('standard → plus: subscriptionItems.create + DB に新 itemId 保存', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      paymentMethod: 'credit_card',
      stripeSubscriptionId: 'sub_xxx',
      stripeSubscriptionItemStorageId: null,
    } as never);
    mockStripeClient.subscriptionItems.create.mockResolvedValueOnce({
      id: 'si_storage_plus_new',
      object: 'subscription_item',
    });

    const result = await syncStorageAddonToStripe(TENANT_ID, 'standard', 'plus');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.action).toBe('created');
      expect(result.value.itemId).toBe('si_storage_plus_new');
    }
    expect(mockStripeClient.subscriptionItems.create).toHaveBeenCalledWith(
      {
        subscription: 'sub_xxx',
        price: 'price_storage_plus_test',
        proration_behavior: 'none',
      },
      expect.objectContaining({ idempotencyKey: expect.stringContaining('storage:') }),
    );
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { stripeSubscriptionItemStorageId: 'si_storage_plus_new' },
    });
  });

  it('plus → standard: subscriptionItems.del + DB の itemId を null クリア', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      paymentMethod: 'credit_card',
      stripeSubscriptionId: 'sub_xxx',
      stripeSubscriptionItemStorageId: 'si_existing_plus',
    } as never);
    mockStripeClient.subscriptionItems.del.mockResolvedValueOnce({
      id: 'si_existing_plus',
      deleted: true,
    });

    const result = await syncStorageAddonToStripe(TENANT_ID, 'plus', 'standard');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.action).toBe('deleted');
    expect(mockStripeClient.subscriptionItems.del).toHaveBeenCalledWith('si_existing_plus', {
      proration_behavior: 'none',
    });
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { stripeSubscriptionItemStorageId: null },
    });
  });

  it('plus → pro_storage: subscriptionItems.update で price 差替 (= itemId は同じ)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      paymentMethod: 'credit_card',
      stripeSubscriptionId: 'sub_xxx',
      stripeSubscriptionItemStorageId: 'si_existing_plus',
    } as never);
    mockStripeClient.subscriptionItems.update.mockResolvedValueOnce({
      id: 'si_existing_plus',
      object: 'subscription_item',
    });

    const result = await syncStorageAddonToStripe(TENANT_ID, 'plus', 'pro_storage');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.action).toBe('updated');
      expect(result.value.itemId).toBe('si_existing_plus');
    }
    expect(mockStripeClient.subscriptionItems.update).toHaveBeenCalledWith('si_existing_plus', {
      price: 'price_storage_pro_test',
      proration_behavior: 'none',
    });
  });

  it('standard → enterprise: 両方とも Stripe 対象外 → no-op (= enterprise は manual billing)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      paymentMethod: 'credit_card',
      stripeSubscriptionId: 'sub_xxx',
      stripeSubscriptionItemStorageId: null,
    } as never);

    const result = await syncStorageAddonToStripe(TENANT_ID, 'standard', 'enterprise');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.action).toBe('noop');
    expect(mockStripeClient.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it('DB 不整合 (plus → pro_storage で itemId=null) → 新規 create にフォールバック', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      paymentMethod: 'credit_card',
      stripeSubscriptionId: 'sub_xxx',
      stripeSubscriptionItemStorageId: null, // 本来あるべきだが欠落
    } as never);
    mockStripeClient.subscriptionItems.create.mockResolvedValueOnce({
      id: 'si_fallback_created',
      object: 'subscription_item',
    });

    const result = await syncStorageAddonToStripe(TENANT_ID, 'plus', 'pro_storage');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.action).toBe('created');
    expect(mockStripeClient.subscriptionItems.create).toHaveBeenCalled();
  });
});
