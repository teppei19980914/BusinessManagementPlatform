/**
 * POST /api/tenants/me/billing/stripe/verify route テスト (PR-S3 / 2026-05-14)
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
  verifyTenantCard: vi.fn(),
}));

import { POST } from './route';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { isStripeEnabled } from '@/lib/stripe';
import { verifyTenantCard } from '@/services/stripe-billing.service';

const ADMIN = { id: 'admin-uuid', tenantId: 'tenant-uuid', systemRole: 'admin' } as never;

function makeReq() {
  return new NextRequest('http://localhost/api/tenants/me/billing/stripe/verify', {
    method: 'POST',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isStripeEnabled).mockReturnValue(true);
  vi.mocked(requireAdmin).mockReturnValue(undefined);
  vi.mocked(getAuthenticatedUser).mockResolvedValue(ADMIN);
});

describe('認可・feature flag', () => {
  it('admin 以外は 403', async () => {
    vi.mocked(requireAdmin).mockReturnValue(new Response(null, { status: 403 }) as never);
    const res = await POST(makeReq());
    expect(res.status).toBe(403);
  });

  it('STRIPE_ENABLED=false → 403 STRIPE_DISABLED', async () => {
    vi.mocked(isStripeEnabled).mockReturnValue(false);
    const res = await POST(makeReq());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('STRIPE_DISABLED');
  });
});

describe('正常系・エラー変換', () => {
  it('検証 valid → 200 + status=valid', async () => {
    vi.mocked(verifyTenantCard).mockResolvedValueOnce({
      ok: true,
      value: {
        status: 'valid',
        cardExpiresAt: { year: 2099, month: 12 },
      },
    });

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('valid');
  });

  it('検証 expired → 200 + status=expired (= verify service が ok=true で返す)', async () => {
    vi.mocked(verifyTenantCard).mockResolvedValueOnce({
      ok: true,
      value: {
        status: 'expired',
        failureReason: 'expired_card',
        cardExpiresAt: { year: 2020, month: 12 },
      },
    });

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('expired');
    expect(body.data.failureReason).toBe('expired_card');
  });

  it('カード未登録 → 409 NO_CARD_REGISTERED', async () => {
    vi.mocked(verifyTenantCard).mockResolvedValueOnce({
      ok: false,
      code: 'invalid_request',
      userMessage: 'カード未登録',
      detail: 'card_not_registered',
    });

    const res = await POST(makeReq());

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('NO_CARD_REGISTERED');
  });

  it('Stripe API エラー → 503', async () => {
    vi.mocked(verifyTenantCard).mockResolvedValueOnce({
      ok: false,
      code: 'api_error',
      userMessage: 'Stripe error',
    });

    const res = await POST(makeReq());

    expect(res.status).toBe(503);
  });
});
