/**
 * POST /api/tenants/me/billing/stripe/setup route テスト (PR-S3 / 2026-05-14)
 *
 * 検証観点:
 *   1. 認可 (未認証 → 401、admin 以外 → 403、admin → 通過)
 *   2. feature flag (STRIPE_ENABLED=false → 403 STRIPE_DISABLED)
 *   3. body バリデーション (returnUrl 必須・URL 形式)
 *   4. 既に credit_card → 409 ALREADY_CREDIT_CARD
 *   5. 正常系 (= service が url を返す → 200 + checkoutUrl)
 *   6. Stripe API エラー → 503
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  requireAdmin: vi.fn(),
}));

vi.mock('@/lib/stripe', () => ({
  isStripeEnabled: vi.fn(() => true),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/services/stripe-billing.service', () => ({
  createCheckoutSessionForCardSetup: vi.fn(),
}));

import { POST } from './route';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { isStripeEnabled } from '@/lib/stripe';
import { prisma } from '@/lib/db';
import { createCheckoutSessionForCardSetup } from '@/services/stripe-billing.service';

const ADMIN = {
  id: 'admin-uuid',
  tenantId: 'tenant-uuid',
  systemRole: 'admin',
} as never;

function makeReq(body: unknown) {
  return new NextRequest('http://localhost/api/tenants/me/billing/stripe/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isStripeEnabled).mockReturnValue(true);
  vi.mocked(requireAdmin).mockReturnValue(undefined as never);
});

describe('認可', () => {
  it('未認証時はそのまま伝播', async () => {
    const unauthResponse = NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
    vi.mocked(getAuthenticatedUser).mockResolvedValue(unauthResponse as never);

    const res = await POST(makeReq({ returnUrl: 'https://app.example/settings/tenant' }));

    expect(res.status).toBe(401);
  });

  it('admin 以外は requireAdmin の 403 を返す', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ ...(ADMIN as object), systemRole: 'general' } as never);
    vi.mocked(requireAdmin).mockReturnValue(
      NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }) as never,
    );

    const res = await POST(makeReq({ returnUrl: 'https://app.example/settings/tenant' }));

    expect(res.status).toBe(403);
  });
});

describe('feature flag', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(ADMIN);
  });

  it('STRIPE_ENABLED=false → 403 STRIPE_DISABLED', async () => {
    vi.mocked(isStripeEnabled).mockReturnValue(false);

    const res = await POST(makeReq({ returnUrl: 'https://app.example/settings/tenant' }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('STRIPE_DISABLED');
  });
});

describe('バリデーション', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(ADMIN);
  });

  it('body 不正 JSON → 400', async () => {
    const res = await POST(makeReq('not-a-json'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returnUrl 欠落 → 400', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(createCheckoutSessionForCardSetup).not.toHaveBeenCalled();
  });

  it('returnUrl が URL 形式でない → 400', async () => {
    const res = await POST(makeReq({ returnUrl: 'not-a-url' }));
    expect(res.status).toBe(400);
    expect(createCheckoutSessionForCardSetup).not.toHaveBeenCalled();
  });
});

describe('Subscription 既存テナント (PR #425 再改修: カード変更モード対応)', () => {
  // PR #425 (2026-05-22) 再改修: 旧 ALREADY_HAS_SUBSCRIPTION 409 ガードを撤去。
  //   理由: Customer Portal でカード変更しても Subscription.default_payment_method は更新されない
  //         (Stripe 仕様)。本サービスでは「クレジットカード情報更新」ボタンから常に Stripe Checkout
  //         に遷移し、completeStripeSetup の「カード変更モード」で Subscription を維持しつつ
  //         default_payment_method のみ update する設計に変更。
  //   そのため stripeSubscriptionId 既存でも setup は許可する。
  //   分岐 (新規作成 vs カード変更モード) は completeStripeSetup 側で吸収。
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(ADMIN);
  });

  it('stripeSubscriptionId 既存でも setup を許可 (= カード変更モード経路)', async () => {
    vi.mocked(createCheckoutSessionForCardSetup).mockResolvedValueOnce({
      ok: true,
      value: { id: 'cs_test', url: 'https://checkout.stripe.com/c/pay/cs_test' } as never,
    } as never);

    const res = await POST(makeReq({ returnUrl: 'https://app.example/settings/tenant' }));

    expect(res.status).toBe(200);
    expect(createCheckoutSessionForCardSetup).toHaveBeenCalled();
  });

  it('stripeSubscriptionId=null でも setup 正常実行 (= 新規 setup 経路)', async () => {
    vi.mocked(createCheckoutSessionForCardSetup).mockResolvedValueOnce({
      ok: true,
      value: { id: 'cs_test', url: 'https://checkout.stripe.com/c/pay/cs_test' } as never,
    } as never);

    const res = await POST(makeReq({ returnUrl: 'https://app.example/settings/tenant' }));

    expect(res.status).toBe(200);
    expect(createCheckoutSessionForCardSetup).toHaveBeenCalled();
  });
});

describe('正常系', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(ADMIN);
  });

  it('成功時 200 + checkoutUrl を返す', async () => {
    vi.mocked(createCheckoutSessionForCardSetup).mockResolvedValueOnce({
      ok: true,
      value: {
        id: 'cs_test',
        url: 'https://checkout.stripe.com/c/pay/cs_test',
      } as never,
    } as never);

    const res = await POST(makeReq({ returnUrl: 'https://app.example/settings/tenant' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.checkoutUrl).toContain('checkout.stripe.com');
    expect(createCheckoutSessionForCardSetup).toHaveBeenCalledWith(
      'tenant-uuid',
      'https://app.example/settings/tenant',
    );
  });

  it('Stripe API 失敗 → 503 STRIPE_API_ERROR', async () => {
    vi.mocked(createCheckoutSessionForCardSetup).mockResolvedValueOnce({
      ok: false,
      code: 'api_error',
      userMessage: 'Stripe 側で一時的なエラー',
    } as never);

    const res = await POST(makeReq({ returnUrl: 'https://app.example/settings/tenant' }));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('STRIPE_API_ERROR');
  });

  it('Session.url が null の場合は 503', async () => {
    vi.mocked(createCheckoutSessionForCardSetup).mockResolvedValueOnce({
      ok: true,
      value: { id: 'cs_test', url: null } as never,
    } as never);

    const res = await POST(makeReq({ returnUrl: 'https://app.example/settings/tenant' }));

    expect(res.status).toBe(503);
  });
});
