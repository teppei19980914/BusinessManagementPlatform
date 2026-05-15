/**
 * /api/cron/stripe-auto-suspend POST の単体テスト (PR-S6 / 2026-05-14)
 *
 * 検証観点:
 *   1. CRON_SECRET 未設定 → 401
 *   2. Authorization ヘッダなし → 401
 *   3. 不正な Bearer → 401
 *   4. 正しい Bearer → service 呼出 + 200
 *   5. GET メソッド → 405
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/services/stripe-auto-suspend.service', () => ({
  autoSuspendDelinquentTenants: vi.fn(),
}));

import { POST, GET } from './route';
import { autoSuspendDelinquentTenants } from '@/services/stripe-auto-suspend.service';

const VALID_SECRET = 'test-cron-secret-32chars-or-more-xxxxxxxxxxxxxxxx';

function cronReq(authHeader?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader) headers.authorization = authHeader;
  return new NextRequest('http://localhost/api/cron/stripe-auto-suspend', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(autoSuspendDelinquentTenants).mockResolvedValue({
    candidates: 0,
    suspended: 0,
    skipped: 0,
    errors: [],
  });
});

describe('POST /api/cron/stripe-auto-suspend', () => {
  it('CRON_SECRET 未設定なら 401', async () => {
    delete process.env.CRON_SECRET;
    const res = await POST(cronReq('Bearer anything'));
    expect(res.status).toBe(401);
    expect(autoSuspendDelinquentTenants).not.toHaveBeenCalled();
  });

  it('Authorization ヘッダなしは 401', async () => {
    process.env.CRON_SECRET = VALID_SECRET;
    const res = await POST(cronReq());
    expect(res.status).toBe(401);
  });

  it('不正な Bearer は 401', async () => {
    process.env.CRON_SECRET = VALID_SECRET;
    const res = await POST(cronReq('Bearer wrong'));
    expect(res.status).toBe(401);
  });

  it('正しい Bearer → service 呼出 + 200', async () => {
    process.env.CRON_SECRET = VALID_SECRET;
    vi.mocked(autoSuspendDelinquentTenants).mockResolvedValue({
      candidates: 3,
      suspended: 2,
      skipped: 1,
      errors: [],
    });

    const res = await POST(cronReq(`Bearer ${VALID_SECRET}`));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.source).toBe('cron');
    expect(json.data.candidates).toBe(3);
    expect(json.data.suspended).toBe(2);
    expect(json.data.skipped).toBe(1);
    expect(autoSuspendDelinquentTenants).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/cron/stripe-auto-suspend', () => {
  it('GET は 405', async () => {
    const res = await GET();
    expect(res.status).toBe(405);
  });
});
