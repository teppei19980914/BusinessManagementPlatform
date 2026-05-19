/**
 * /api/cron/stripe-reconcile POST の単体テスト (PR-V7 #5 / 2026-05-19)
 *
 * 検証観点:
 *   1. CRON_SECRET 未設定 → 401
 *   2. Authorization ヘッダなし → 401
 *   3. 不正な Bearer → 401
 *   4. 正しい Bearer → service 呼出 + 200
 *   5. GET → 405
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/services/stripe-reconcile.service', () => ({
  reconcileStripeSubscriptions: vi.fn(),
  reconcileBillingHistoryAmounts: vi.fn(),
}));

// cron-execution-log のラッパは実体を通す (= db への書込を mock)
vi.mock('@/lib/db', () => ({
  prisma: {
    cronExecutionLog: {
      create: vi.fn().mockResolvedValue({ id: 'cron-log-id' }),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

import { POST, GET } from './route';
import {
  reconcileStripeSubscriptions,
  reconcileBillingHistoryAmounts,
} from '@/services/stripe-reconcile.service';

const VALID_SECRET = 'test-cron-secret-32chars-or-more-xxxxxxxxxxxxxxxx';

function cronReq(authHeader?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader) headers.authorization = authHeader;
  return new NextRequest('http://localhost/api/cron/stripe-reconcile', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reconcileStripeSubscriptions).mockResolvedValue({
    candidates: 0,
    matched: 0,
    corrected: 0,
    lostAndCanceled: 0,
    errors: [],
  });
  // PR-V7a B-2: route が追加で呼出すようになった金額照合の mock
  vi.mocked(reconcileBillingHistoryAmounts).mockResolvedValue({
    candidates: 0,
    matched: 0,
    drifted: 0,
    invoiceNotFound: 0,
    errors: [],
  });
});

describe('POST /api/cron/stripe-reconcile', () => {
  it('CRON_SECRET 未設定なら 401', async () => {
    delete process.env.CRON_SECRET;
    const res = await POST(cronReq('Bearer anything'));
    expect(res.status).toBe(401);
    expect(reconcileStripeSubscriptions).not.toHaveBeenCalled();
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
    vi.mocked(reconcileStripeSubscriptions).mockResolvedValue({
      candidates: 5,
      matched: 4,
      corrected: 1,
      lostAndCanceled: 0,
      errors: [],
    });

    const res = await POST(cronReq(`Bearer ${VALID_SECRET}`));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.source).toBe('cron');
    // PR-V7a B-2 (2026-05-19): レスポンスは { subscriptions, amounts } で分離
    expect(json.data.subscriptions.candidates).toBe(5);
    expect(json.data.subscriptions.matched).toBe(4);
    expect(json.data.subscriptions.corrected).toBe(1);
    expect(json.data.amounts).toBeDefined();
    expect(reconcileStripeSubscriptions).toHaveBeenCalledTimes(1);
    expect(reconcileBillingHistoryAmounts).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/cron/stripe-reconcile', () => {
  it('GET は 405', async () => {
    const res = await GET();
    expect(res.status).toBe(405);
  });
});
