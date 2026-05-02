import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/services/tenant-monthly-reset.service', () => ({
  runTenantMonthlyReset: vi.fn(),
}));

import { POST, GET } from './route';
import { runTenantMonthlyReset } from '@/services/tenant-monthly-reset.service';

const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'test-cron-secret-xyz';
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = ORIGINAL_SECRET;
  }
});

function makeReq(authHeader?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader) headers['authorization'] = authHeader;
  return new NextRequest('http://localhost/api/cron/tenant-monthly-reset', {
    method: 'POST',
    headers,
  });
}

describe('POST /api/cron/tenant-monthly-reset', () => {
  it('正しい CRON_SECRET で 200 + 実行結果を返す', async () => {
    vi.mocked(runTenantMonthlyReset).mockResolvedValue({
      resetCount: 3,
      planAppliedCount: 1,
      invalidPlanSkippedCount: 0,
    });

    const res = await POST(makeReq('Bearer test-cron-secret-xyz'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      source: 'cron',
      resetCount: 3,
      planAppliedCount: 1,
      invalidPlanSkippedCount: 0,
    });
    expect(runTenantMonthlyReset).toHaveBeenCalledTimes(1);
  });

  it('Authorization ヘッダなしで 401', async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(runTenantMonthlyReset).not.toHaveBeenCalled();
  });

  it('不正な Bearer トークンで 401', async () => {
    const res = await POST(makeReq('Bearer wrong-secret'));
    expect(res.status).toBe(401);
    expect(runTenantMonthlyReset).not.toHaveBeenCalled();
  });

  it('CRON_SECRET 未設定環境では常に 401 (fail-closed)', async () => {
    delete process.env.CRON_SECRET;
    const res = await POST(makeReq('Bearer anything'));
    expect(res.status).toBe(401);
    expect(runTenantMonthlyReset).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/tenant-monthly-reset', () => {
  it('GET は 405 で明示的に弾く', async () => {
    const res = await GET();
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error.code).toBe('METHOD_NOT_ALLOWED');
  });
});
