/**
 * POST /api/auth/signup (ADR-0016 Revised / 2026-05-22)
 *
 * 検証観点:
 *   1. plan 強制上書き削除: UI で Expert を選んだら Expert のまま service に渡る (旧 P-B の
 *      'beginner' 上書き廃止。スクショエラーの直接原因の修正検証)
 *   2. 3 層エラーハンドリング: OWNED_TENANT_EXISTS (HTTP 409) / BEGINNER_REQUIRES_UPGRADE (HTTP 409) /
 *      SLUG_CONFLICT / EMAIL_SEND_FAILED / RATE_LIMITED
 *   3. honeypot bot 検知: hp_url が埋まっていれば service 未呼出で silently 200
 *
 *  rate-limit と service のモック化により、API ルートの薄い層を集中的に検証する。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/services/tenant-onboarding.service', () => ({
  createTenantBySignup: vi.fn(),
}));

vi.mock('@/lib/llm/rate-limiter', () => ({
  getDefaultRateLimiter: vi.fn(() => ({
    check: vi.fn().mockResolvedValue({ allowed: true }),
  })),
}));

import { POST } from './route';
import { createTenantBySignup } from '@/services/tenant-onboarding.service';

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  name: 'Tasty Customer',
  slug: 'tasty-customer',
  plan: 'expert',
  billingType: 'corporate',
  billingCompanyName: 'Tasty Co.',
  billingContactName: '山田 太郎',
  billingContactEmail: 'billing@example.com',
  billingPostalCode: '100-0001',
  billingPrefecture: '東京都',
  billingCity: '千代田区',
  billingStreetAddress: '千代田1-1',
  billingPhoneNumber: '03-1234-5678',
  paymentMethod: 'invoice',
  initialAdminName: 'admin Yamada',
  initialAdminEmail: 'admin@example.com',
  acceptedTerms: true,
  acceptedPrivacy: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createTenantBySignup).mockResolvedValue({
    ok: true,
    tenantId: 'tenant-uuid',
    initialAdminUserId: 'admin-uuid',
    // feat/signup-friction-reduction (2026-06-12): サーバ自動採番された組織 ID
    slug: '100000',
  });
});

describe('POST /api/auth/signup — plan 強制上書き削除 (ADR-0016 Revised / 2026-05-22)', () => {
  it('UI で Expert を選んだら Expert のまま service に渡る (旧 plan=beginner 上書き廃止)', async () => {
    await POST(makeReq({ ...VALID_BODY, plan: 'expert' }));

    expect(createTenantBySignup).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'expert' }),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('UI で Pro を選んだら Pro のまま service に渡る', async () => {
    await POST(makeReq({ ...VALID_BODY, plan: 'pro' }));

    expect(createTenantBySignup).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'pro' }),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('UI で Beginner を選んだら Beginner のまま service に渡る (= 層 3 新規)', async () => {
    await POST(makeReq({ ...VALID_BODY, plan: 'beginner' }));

    expect(createTenantBySignup).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'beginner' }),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('honeypot (hp_url) が埋まっている bot リクエストは service 未呼出で silently 200', async () => {
    const res = await POST(makeReq({ ...VALID_BODY, hp_url: 'http://evil.example' }));

    expect(res.status).toBe(200);
    expect(createTenantBySignup).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/signup — 3 層エラーハンドリング (ADR-0016 Revised)', () => {
  it('層 1: OWNED_TENANT_EXISTS は HTTP 409 + code を返却', async () => {
    vi.mocked(createTenantBySignup).mockResolvedValue({
      ok: false,
      reason: 'OWNED_TENANT_EXISTS',
      message: '自前テナント保有ユーザの追加払い出しはシステム管理者へ',
    });

    const res = await POST(makeReq(VALID_BODY));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('OWNED_TENANT_EXISTS');
    expect(body.error.message).toContain('システム管理者');
  });

  it('層 2: BEGINNER_REQUIRES_UPGRADE は HTTP 409 + code を返却', async () => {
    vi.mocked(createTenantBySignup).mockResolvedValue({
      ok: false,
      reason: 'BEGINNER_REQUIRES_UPGRADE',
      message: 'Expert または Pro プランをご選択ください',
    });

    const res = await POST(makeReq({ ...VALID_BODY, plan: 'beginner' }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('BEGINNER_REQUIRES_UPGRADE');
  });

  it('VALIDATION_ERROR は HTTP 400', async () => {
    vi.mocked(createTenantBySignup).mockResolvedValue({
      ok: false,
      reason: 'VALIDATION_ERROR',
      message: 'slug 形式不正',
    });

    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(400);
  });

  it('SLUG_CONFLICT は HTTP 409', async () => {
    vi.mocked(createTenantBySignup).mockResolvedValue({
      ok: false,
      reason: 'SLUG_CONFLICT',
      message: 'slug 重複',
    });

    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(409);
  });

  it('EMAIL_SEND_FAILED は HTTP 502', async () => {
    vi.mocked(createTenantBySignup).mockResolvedValue({
      ok: false,
      reason: 'EMAIL_SEND_FAILED',
      message: '招待メール送信失敗',
    });

    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(502);
  });
});
