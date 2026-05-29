/**
 * GET /api/tenants/me/billing/stripe/setup/complete route テスト (PR-S3 / 2026-05-14)
 *
 * 検証観点:
 *   1. 認可 (未認証 → 401、admin 以外 → 403)
 *   2. feature flag (= 無効時はトップへフォールバック)
 *   3. session_id 欠落 → failed リダイレクト
 *   4. return_to オープンリダイレクト対策 (= 異オリジンは /settings/tenant にフォールバック)
 *   5. service 成功 → success リダイレクト
 *   6. service 失敗 → failed&reason=... リダイレクト
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
  completeStripeSetup: vi.fn(),
}));

import { GET } from './route';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { isStripeEnabled } from '@/lib/stripe';
import { prisma } from '@/lib/db';
import { completeStripeSetup } from '@/services/stripe-billing.service';

const ADMIN = {
  id: 'admin-uuid',
  tenantId: 'tenant-uuid',
  systemRole: 'admin',
} as never;

function makeReq(query: Record<string, string>) {
  const url = new URL('http://localhost/api/tenants/me/billing/stripe/setup/complete');
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url.toString());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isStripeEnabled).mockReturnValue(true);
  vi.mocked(requireAdmin).mockReturnValue(undefined as never);
  vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ timezone: 'Asia/Tokyo' } as never);
});

describe('認可', () => {
  it('未認証時は伝播', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(
      NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }) as never,
    );
    const res = await GET(makeReq({ session_id: 'cs_xxx', return_to: 'http://localhost/settings/tenant' }));
    expect(res.status).toBe(401);
  });

  it('admin 以外は requireAdmin の 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(ADMIN);
    vi.mocked(requireAdmin).mockReturnValue(
      NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }) as never,
    );
    const res = await GET(makeReq({ session_id: 'cs_xxx', return_to: 'http://localhost/settings/tenant' }));
    expect(res.status).toBe(403);
  });
});

describe('feature flag', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(ADMIN);
  });

  it('STRIPE_ENABLED=false → / へリダイレクト', async () => {
    vi.mocked(isStripeEnabled).mockReturnValue(false);
    const res = await GET(makeReq({ session_id: 'cs_xxx' }));
    // NextResponse.redirect は default 307 (= 一時的、Next.js 15 標準)
    expect([302, 307]).toContain(res.status);
    expect(res.headers.get('location')).toBe('http://localhost/');
  });
});

describe('session_id 欠落', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(ADMIN);
  });

  it('session_id なし → return_to に failed&reason=session_id_missing', async () => {
    const res = await GET(makeReq({ return_to: 'http://localhost/settings/tenant' }));
    expect([302, 307]).toContain(res.status);
    const loc = res.headers.get('location')!;
    expect(loc).toContain('stripe_setup=failed');
    expect(loc).toContain('reason=session_id_missing');
    expect(completeStripeSetup).not.toHaveBeenCalled();
  });
});

describe('return_to サニタイズ (オープンリダイレクト対策)', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(ADMIN);
    vi.mocked(completeStripeSetup).mockResolvedValue({
      ok: true,
      value: { subscriptionId: 'sub', customerId: 'cus', paymentMethodId: 'pm' },
    } as never);
  });

  it('return_to が異オリジン → /settings/tenant にフォールバック', async () => {
    const res = await GET(makeReq({
      session_id: 'cs_xxx',
      return_to: 'https://evil.example/phishing',
    }));
    expect([302, 307]).toContain(res.status);
    const loc = res.headers.get('location')!;
    expect(loc).not.toContain('evil.example');
    expect(loc).toContain('http://localhost/settings/tenant');
  });

  it('return_to が URL 形式でない → /settings/tenant にフォールバック', async () => {
    const res = await GET(makeReq({
      session_id: 'cs_xxx',
      return_to: 'not-a-url',
    }));
    expect([302, 307]).toContain(res.status);
    const loc = res.headers.get('location')!;
    expect(loc).toContain('http://localhost/settings/tenant');
  });

  it('return_to 欠落 → /settings/tenant にフォールバック', async () => {
    const res = await GET(makeReq({ session_id: 'cs_xxx' }));
    expect([302, 307]).toContain(res.status);
    const loc = res.headers.get('location')!;
    expect(loc).toContain('http://localhost/settings/tenant');
  });
});

describe('completeStripeSetup の結果に応じたリダイレクト', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(ADMIN);
  });

  it('成功 → stripe_setup=success', async () => {
    vi.mocked(completeStripeSetup).mockResolvedValueOnce({
      ok: true,
      value: { subscriptionId: 'sub', customerId: 'cus', paymentMethodId: 'pm' },
    } as never);
    const res = await GET(makeReq({
      session_id: 'cs_xxx',
      return_to: 'http://localhost/settings/tenant',
    }));
    const loc = res.headers.get('location')!;
    expect(loc).toContain('stripe_setup=success');
  });

  it('card_declined → reason に declineCode', async () => {
    vi.mocked(completeStripeSetup).mockResolvedValueOnce({
      ok: false,
      code: 'card_declined',
      declineCode: 'insufficient_funds',
      userMessage: '残高不足',
      severity: 'high',
    } as never);
    const res = await GET(makeReq({
      session_id: 'cs_xxx',
      return_to: 'http://localhost/settings/tenant',
    }));
    const loc = res.headers.get('location')!;
    expect(loc).toContain('stripe_setup=failed');
    expect(loc).toContain('reason=insufficient_funds');
  });

  it('invalid_request + detail → reason=detail', async () => {
    vi.mocked(completeStripeSetup).mockResolvedValueOnce({
      ok: false,
      code: 'invalid_request',
      userMessage: '...',
      detail: 'session_status_expired',
    } as never);
    const res = await GET(makeReq({
      session_id: 'cs_xxx',
      return_to: 'http://localhost/settings/tenant',
    }));
    const loc = res.headers.get('location')!;
    expect(loc).toContain('reason=session_status_expired');
  });

  it('authentication → reason=authentication_error', async () => {
    vi.mocked(completeStripeSetup).mockResolvedValueOnce({
      ok: false,
      code: 'authentication',
      userMessage: '...',
    } as never);
    const res = await GET(makeReq({
      session_id: 'cs_xxx',
      return_to: 'http://localhost/settings/tenant',
    }));
    const loc = res.headers.get('location')!;
    expect(loc).toContain('reason=authentication_error');
  });

  it('api_error → reason=processing_error', async () => {
    vi.mocked(completeStripeSetup).mockResolvedValueOnce({
      ok: false,
      code: 'api_error',
      userMessage: '...',
    } as never);
    const res = await GET(makeReq({
      session_id: 'cs_xxx',
      return_to: 'http://localhost/settings/tenant',
    }));
    const loc = res.headers.get('location')!;
    expect(loc).toContain('reason=processing_error');
  });
});
