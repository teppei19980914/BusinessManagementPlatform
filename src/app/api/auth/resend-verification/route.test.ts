/**
 * POST /api/auth/resend-verification (Phase 1 / feat/signup-email-resend-ux / 2026-05-23)
 *
 * 検証観点:
 *   1. 入力 zod 検証: email 形式 / tenantSlug 形式
 *   2. 3 軸 Rate Limit: IP / tenantSlug / email それぞれの 429 経路
 *   3. service 呼出が正しい引数で行われる
 *   4. silent_skip (= enumeration 防止) と sent が同じ 200 レスポンスになる
 *   5. EMAIL_SEND_FAILED は 502 で返る
 *
 * rate-limit と service をモック化して、API ルートの薄い層を集中的に検証する。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockRateLimitCheck = vi.fn().mockResolvedValue({ allowed: true });
vi.mock('@/lib/llm/rate-limiter', () => ({
  getDefaultRateLimiter: vi.fn(() => ({ check: mockRateLimitCheck })),
}));

vi.mock('@/services/email-verification.service', () => ({
  resendVerificationEmail: vi.fn(),
}));

import { POST } from './route';
import { resendVerificationEmail } from '@/services/email-verification.service';

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/auth/resend-verification', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  email: 'admin@customer-a.example',
  tenantSlug: 'customer-a',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimitCheck.mockResolvedValue({ allowed: true });
  vi.mocked(resendVerificationEmail).mockResolvedValue({ ok: true, reason: 'sent' });
});

describe('POST /api/auth/resend-verification', () => {
  it('正常系: service 呼出 + 200 + 構造化 data 返却', async () => {
    const res = await POST(makeReq(VALID_BODY));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data?.message).toContain('再送しました');
    expect(resendVerificationEmail).toHaveBeenCalledWith(
      VALID_BODY.email,
      VALID_BODY.tenantSlug,
      expect.any(String),
    );
  });

  it('enumeration 防止: silent_skip も 200 で同一 message を返す (= sent と区別できない)', async () => {
    vi.mocked(resendVerificationEmail).mockResolvedValue({ ok: true, reason: 'silent_skip' });

    const res = await POST(makeReq(VALID_BODY));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data?.message).toContain('再送しました');
  });

  it('VALIDATION_ERROR: email 形式不正は 400', async () => {
    const res = await POST(makeReq({ ...VALID_BODY, email: 'not-email' }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error?.code).toBe('VALIDATION_ERROR');
    expect(resendVerificationEmail).not.toHaveBeenCalled();
  });

  it('VALIDATION_ERROR: tenantSlug 形式不正は 400', async () => {
    const res = await POST(makeReq({ ...VALID_BODY, tenantSlug: 'INVALID UPPERCASE' }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error?.code).toBe('VALIDATION_ERROR');
  });

  it('VALIDATION_ERROR: 必須フィールド欠落 (email) は 400', async () => {
    const { tenantSlug } = VALID_BODY;
    const res = await POST(makeReq({ tenantSlug }));

    expect(res.status).toBe(400);
  });

  it('RATE_LIMITED: IP 軸で 429 + Retry-After ヘッダ', async () => {
    // 最初の check (IP 軸) で拒否
    mockRateLimitCheck.mockResolvedValueOnce({ allowed: false, retryAfterSec: 600 });

    const res = await POST(makeReq(VALID_BODY));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(resendVerificationEmail).not.toHaveBeenCalled();
  });

  it('RATE_LIMITED: tenant 軸で 429 (IP は通過、tenant 軸で拒否)', async () => {
    mockRateLimitCheck
      .mockResolvedValueOnce({ allowed: true }) // IP 軸通過
      .mockResolvedValueOnce({ allowed: false, retryAfterSec: 300 }); // tenant 軸拒否

    const res = await POST(makeReq(VALID_BODY));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('300');
    expect(resendVerificationEmail).not.toHaveBeenCalled();
  });

  it('RATE_LIMITED: email 軸で 429 (IP / tenant 通過、email 軸で拒否)', async () => {
    mockRateLimitCheck
      .mockResolvedValueOnce({ allowed: true }) // IP 軸
      .mockResolvedValueOnce({ allowed: true }) // tenant 軸
      .mockResolvedValueOnce({ allowed: false, retryAfterSec: 86400 }); // email 軸

    const res = await POST(makeReq(VALID_BODY));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('86400');
    expect(resendVerificationEmail).not.toHaveBeenCalled();
  });

  it('EMAIL_SEND_FAILED: service が ok=false を返したら 502', async () => {
    vi.mocked(resendVerificationEmail).mockResolvedValue({
      ok: false,
      reason: 'EMAIL_SEND_FAILED',
      message: 'メール送信に失敗しました。',
    });

    const res = await POST(makeReq(VALID_BODY));

    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error?.code).toBe('EMAIL_SEND_FAILED');
  });

  it('不正 JSON body は 400 VALIDATION_ERROR', async () => {
    const req = new NextRequest('http://localhost/api/auth/resend-verification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error?.code).toBe('VALIDATION_ERROR');
  });

  it('Rate Limit キー: IP / tenant / email の 3 軸で異なるキーで check される', async () => {
    const checkSpy = mockRateLimitCheck;
    checkSpy
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: true });

    await POST(makeReq(VALID_BODY));

    expect(checkSpy).toHaveBeenCalledTimes(3);
    const keys = checkSpy.mock.calls.map((c) => c[0] as string);
    expect(keys.some((k) => k.startsWith('resend:ip:'))).toBe(true);
    expect(keys.some((k) => k.startsWith('resend:tenant:'))).toBe(true);
    expect(keys.some((k) => k.startsWith('resend:email:'))).toBe(true);
  });
});
