/**
 * /api/cron/stripe-usage-flush POST の単体テスト (PR-S6 / 2026-05-14)
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

vi.mock('@/services/stripe-usage-flush.service', () => ({
  flushStripeUsageRecordQueue: vi.fn(),
}));

import { POST, GET } from './route';
import { flushStripeUsageRecordQueue } from '@/services/stripe-usage-flush.service';

const VALID_SECRET = 'test-cron-secret-32chars-or-more-xxxxxxxxxxxxxxxx';

function cronReq(authHeader?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader) headers.authorization = authHeader;
  return new NextRequest('http://localhost/api/cron/stripe-usage-flush', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(flushStripeUsageRecordQueue).mockResolvedValue({
    candidates: 0,
    succeeded: 0,
    failed: 0,
    dlq: 0,
    skipped: false,
  });
});

describe('POST /api/cron/stripe-usage-flush', () => {
  it('CRON_SECRET 未設定なら 401', async () => {
    delete process.env.CRON_SECRET;
    const res = await POST(cronReq('Bearer anything'));
    expect(res.status).toBe(401);
    expect(flushStripeUsageRecordQueue).not.toHaveBeenCalled();
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
    vi.mocked(flushStripeUsageRecordQueue).mockResolvedValue({
      candidates: 5,
      succeeded: 3,
      failed: 1,
      dlq: 1,
      skipped: false,
    });

    const res = await POST(cronReq(`Bearer ${VALID_SECRET}`));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.source).toBe('cron');
    expect(json.data.candidates).toBe(5);
    expect(json.data.succeeded).toBe(3);
    expect(json.data.failed).toBe(1);
    expect(json.data.dlq).toBe(1);
    expect(flushStripeUsageRecordQueue).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/cron/stripe-usage-flush', () => {
  it('GET は 405', async () => {
    const res = await GET();
    expect(res.status).toBe(405);
  });
});
