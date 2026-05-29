/**
 * POST /api/tenants/me/billing/stripe/portal route テスト (PR-S3 / 2026-05-14)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  requireAdmin: vi.fn(),
}));

vi.mock('@/lib/stripe', () => ({
  isStripeEnabled: vi.fn(() => true),
}));

vi.mock('@/services/stripe-billing.service', () => ({
  createCustomerPortalSession: vi.fn(),
}));

import { POST } from './route';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { isStripeEnabled } from '@/lib/stripe';
import { createCustomerPortalSession } from '@/services/stripe-billing.service';

const ADMIN = { id: 'admin-uuid', tenantId: 'tenant-uuid', systemRole: 'admin' } as never;

function makeReq(body: unknown) {
  return new NextRequest('http://localhost/api/tenants/me/billing/stripe/portal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isStripeEnabled).mockReturnValue(true);
  vi.mocked(requireAdmin).mockReturnValue(undefined as never);
  vi.mocked(getAuthenticatedUser).mockResolvedValue(ADMIN);
});

describe('認可', () => {
  it('admin 以外は 403', async () => {
    vi.mocked(requireAdmin).mockReturnValue(new Response(null, { status: 403 }) as never);
    const res = await POST(makeReq({ returnUrl: 'https://app.example/settings/tenant' }));
    expect(res.status).toBe(403);
  });
});

describe('feature flag', () => {
  it('STRIPE_ENABLED=false → 403', async () => {
    vi.mocked(isStripeEnabled).mockReturnValue(false);
    const res = await POST(makeReq({ returnUrl: 'https://app.example/settings/tenant' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('STRIPE_DISABLED');
  });
});

describe('バリデーション', () => {
  it('returnUrl 欠落 → 400', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });
});

describe('正常系・エラー変換', () => {
  it('成功時 200 + portalUrl', async () => {
    vi.mocked(createCustomerPortalSession).mockResolvedValueOnce({
      ok: true,
      value: { id: 'bps_xxx', url: 'https://billing.stripe.com/p/session/xxx' } as never,
    } as never);

    const res = await POST(makeReq({ returnUrl: 'https://app.example/settings/tenant' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.portalUrl).toContain('billing.stripe.com');
  });

  it('Customer 未登録 → 409 NO_STRIPE_CUSTOMER', async () => {
    vi.mocked(createCustomerPortalSession).mockResolvedValueOnce({
      ok: false,
      code: 'invalid_request',
      userMessage: '未登録',
      detail: 'stripe_customer_id_missing',
    } as never);

    const res = await POST(makeReq({ returnUrl: 'https://app.example/settings/tenant' }));

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('NO_STRIPE_CUSTOMER');
  });

  it('Stripe API エラー → 503', async () => {
    vi.mocked(createCustomerPortalSession).mockResolvedValueOnce({
      ok: false,
      code: 'api_error',
      userMessage: 'Stripe error',
    } as never);

    const res = await POST(makeReq({ returnUrl: 'https://app.example/settings/tenant' }));

    expect(res.status).toBe(503);
  });
});
