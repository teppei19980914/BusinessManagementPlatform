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
  vi.mocked(requireAdmin).mockReturnValue(undefined);
});

describe('認可', () => {
  it('未認証時はそのまま伝播', async () => {
    const unauthResponse = NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
    vi.mocked(getAuthenticatedUser).mockResolvedValue(unauthResponse as never);

    const res = await POST(makeReq({ returnUrl: 'https://app.example/settings/tenant' }));

    expect(res.status).toBe(401);
  });

  it('admin 以外は requireAdmin の 403 を返す', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ ...ADMIN, systemRole: 'general' });
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

describe('既に credit_card 払い', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(ADMIN);
  });

  it('paymentMethod === credit_card → 409 ALREADY_CREDIT_CARD', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
      paymentMethod: 'credit_card',
    } as never);

    const res = await POST(makeReq({ returnUrl: 'https://app.example/settings/tenant' }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('ALREADY_CREDIT_CARD');
    expect(createCheckoutSessionForCardSetup).not.toHaveBeenCalled();
  });
});

describe('正常系', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(ADMIN);
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ paymentMethod: 'invoice' } as never);
  });

  it('成功時 200 + checkoutUrl を返す', async () => {
    vi.mocked(createCheckoutSessionForCardSetup).mockResolvedValueOnce({
      ok: true,
      value: {
        id: 'cs_test',
        url: 'https://checkout.stripe.com/c/pay/cs_test',
      } as never,
    });

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
    });

    const res = await POST(makeReq({ returnUrl: 'https://app.example/settings/tenant' }));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('STRIPE_API_ERROR');
  });

  it('Session.url が null の場合は 503', async () => {
    vi.mocked(createCheckoutSessionForCardSetup).mockResolvedValueOnce({
      ok: true,
      value: { id: 'cs_test', url: null } as never,
    });

    const res = await POST(makeReq({ returnUrl: 'https://app.example/settings/tenant' }));

    expect(res.status).toBe(503);
  });
});
