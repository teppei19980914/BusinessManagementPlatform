/**
 * stripe-usage-flush.service の単体テスト (PR-S6 / 2026-05-14)
 *
 * 検証観点:
 *   1. STRIPE_ENABLED=false → 即 return skipped=true
 *   2. 候補ゼロ件 → 0 件処理で返却
 *   3. 送信成功時: sentAt セット + nextSendAt=null
 *   4. 送信失敗時: retryCount++, nextSendAt=now+backoff
 *   5. 5 回失敗 (= retryCount=5) で nextSendAt=null (DLQ)
 *   6. subscriptionItemId 未設定 → DLQ + lastError 記録
 *   7. callType=sonnet なら sonnetItemId、それ以外なら haikuItemId を参照
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Prisma モック
vi.mock('@/lib/db', () => ({
  prisma: {
    stripeUsageRecordQueue: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

// Stripe feature flag モック
let stripeEnabled = true;
vi.mock('@/lib/stripe', () => ({
  isStripeEnabled: () => stripeEnabled,
}));

// reportUsage モック (= service 層を直接 mock せず、stripe-billing.service 経由を mock)
const mockReportUsage = vi.fn();
vi.mock('./stripe-billing.service', () => ({
  reportUsage: (input: unknown) => mockReportUsage(input),
}));

import { prisma } from '@/lib/db';
import { flushStripeUsageRecordQueue } from './stripe-usage-flush.service';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const API_CALL_LOG_ID = '00000000-0000-0000-0000-000000000099';

function buildQueueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'queue-row-1',
    tenantId: TENANT_ID,
    callType: 'haiku',
    apiCallLogId: API_CALL_LOG_ID,
    quantity: 1,
    occurredAt: new Date('2026-05-14T10:00:00Z'),
    retryCount: 0,
    nextSendAt: new Date('2026-05-14T10:01:00Z'),
    sentAt: null,
    lastError: null,
    createdAt: new Date('2026-05-14T10:00:30Z'),
    // PR-V8 (2026-05-19): Meter API 移行に伴い stripeCustomerId に変更
    //   (旧 stripeSubscriptionItem*Id は使用しなくなった)
    tenant: {
      stripeCustomerId: 'cus_test_xxx',
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stripeEnabled = true;
});

describe('flushStripeUsageRecordQueue', () => {
  it('STRIPE_ENABLED=false なら即 return skipped=true (= Stripe 側へ何も送らない)', async () => {
    stripeEnabled = false;
    const result = await flushStripeUsageRecordQueue();
    expect(result.skipped).toBe(true);
    expect(result.candidates).toBe(0);
    expect(prisma.stripeUsageRecordQueue.findMany).not.toHaveBeenCalled();
  });

  it('候補ゼロ件なら 0 件で返却', async () => {
    vi.mocked(prisma.stripeUsageRecordQueue.findMany).mockResolvedValue([] as never);
    const result = await flushStripeUsageRecordQueue();
    expect(result).toEqual({
      candidates: 0,
      succeeded: 0,
      failed: 0,
      dlq: 0,
      skipped: false,
    });
  });

  it('送信成功時: sentAt セット + nextSendAt=null + lastError=null', async () => {
    vi.mocked(prisma.stripeUsageRecordQueue.findMany).mockResolvedValue([buildQueueRow()] as never);
    vi.mocked(prisma.stripeUsageRecordQueue.update).mockResolvedValue({} as never);
    mockReportUsage.mockResolvedValue({ ok: true, value: { id: 'ur_123' } });

    const result = await flushStripeUsageRecordQueue();

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.dlq).toBe(0);

    const updateCall = vi.mocked(prisma.stripeUsageRecordQueue.update).mock.calls[0]?.[0];
    expect(updateCall?.where.id).toBe('queue-row-1');
    expect(updateCall?.data.sentAt).toBeInstanceOf(Date);
    expect(updateCall?.data.nextSendAt).toBeNull();
    expect(updateCall?.data.lastError).toBeNull();

    // PR-V8 (2026-05-19): Meter API 移行 — stripeCustomerId + callType を渡す
    expect(mockReportUsage).toHaveBeenCalledWith({
      stripeCustomerId: 'cus_test_xxx',
      callType: 'haiku',
      quantity: 1,
      occurredAt: expect.any(Date),
      apiCallLogId: API_CALL_LOG_ID,
    });
  });

  it('callType=sonnet なら callType=sonnet で reportUsage 呼出 (PR-V8 Meter API)', async () => {
    vi.mocked(prisma.stripeUsageRecordQueue.findMany).mockResolvedValue([
      buildQueueRow({ callType: 'sonnet' }),
    ] as never);
    vi.mocked(prisma.stripeUsageRecordQueue.update).mockResolvedValue({} as never);
    mockReportUsage.mockResolvedValue({ ok: true, value: {} });

    await flushStripeUsageRecordQueue();

    expect(mockReportUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        callType: 'sonnet',
        stripeCustomerId: 'cus_test_xxx',
      }),
    );
  });

  it('[PR-V8] stripeCustomerId 未設定 → DLQ (nextSendAt=null + lastError 記録)', async () => {
    vi.mocked(prisma.stripeUsageRecordQueue.findMany).mockResolvedValue([
      buildQueueRow({
        callType: 'haiku',
        tenant: { stripeCustomerId: null },
      }),
    ] as never);
    vi.mocked(prisma.stripeUsageRecordQueue.update).mockResolvedValue({} as never);

    const result = await flushStripeUsageRecordQueue();

    expect(result.dlq).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(mockReportUsage).not.toHaveBeenCalled();

    const updateCall = vi.mocked(prisma.stripeUsageRecordQueue.update).mock.calls[0]?.[0];
    expect(updateCall?.data.nextSendAt).toBeNull();
    expect(updateCall?.data.lastError).toContain('Stripe Customer ID is null');
  });

  it('送信失敗 (1 回目) → retryCount=1 + nextSendAt=now+1分', async () => {
    vi.mocked(prisma.stripeUsageRecordQueue.findMany).mockResolvedValue([buildQueueRow()] as never);
    vi.mocked(prisma.stripeUsageRecordQueue.update).mockResolvedValue({} as never);
    mockReportUsage.mockResolvedValue({
      ok: false,
      code: 'rate_limit',
      retryAfterSec: 5,
      userMessage: 'rate limit',
    });

    const result = await flushStripeUsageRecordQueue();

    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.dlq).toBe(0);

    const updateCall = vi.mocked(prisma.stripeUsageRecordQueue.update).mock.calls[0]?.[0];
    expect(updateCall?.data.retryCount).toBe(1);
    const nextSendAt = updateCall?.data.nextSendAt as Date;
    expect(nextSendAt).toBeInstanceOf(Date);
    // 約 1 分後 (= 50〜70 秒の範囲で許容)
    const deltaMs = nextSendAt.getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(50_000);
    expect(deltaMs).toBeLessThan(70_000);
    expect(updateCall?.data.lastError).toBe('rate limit');
  });

  it('送信失敗 (6 回目 / retryCount=5 → 6) → nextSendAt=null (DLQ、5 段階の backoff を使い切った)', async () => {
    vi.mocked(prisma.stripeUsageRecordQueue.findMany).mockResolvedValue([
      buildQueueRow({ retryCount: 5 }),
    ] as never);
    vi.mocked(prisma.stripeUsageRecordQueue.update).mockResolvedValue({} as never);
    mockReportUsage.mockResolvedValue({
      ok: false,
      code: 'api_error',
      userMessage: 'persistent error',
    });

    const result = await flushStripeUsageRecordQueue();

    expect(result.dlq).toBe(1);
    expect(result.failed).toBe(0);

    const updateCall = vi.mocked(prisma.stripeUsageRecordQueue.update).mock.calls[0]?.[0];
    expect(updateCall?.data.retryCount).toBe(6);
    expect(updateCall?.data.nextSendAt).toBeNull();
  });

  it('5 回目失敗 (retryCount=4 → 5) では backoff[4]=240 分なので nextSendAt=now+240分 (まだ DLQ ではない)', async () => {
    vi.mocked(prisma.stripeUsageRecordQueue.findMany).mockResolvedValue([
      buildQueueRow({ retryCount: 4 }),
    ] as never);
    vi.mocked(prisma.stripeUsageRecordQueue.update).mockResolvedValue({} as never);
    mockReportUsage.mockResolvedValue({
      ok: false,
      code: 'api_error',
      userMessage: 'persistent error',
    });

    const result = await flushStripeUsageRecordQueue();

    expect(result.failed).toBe(1);
    expect(result.dlq).toBe(0);

    const updateCall = vi.mocked(prisma.stripeUsageRecordQueue.update).mock.calls[0]?.[0];
    expect(updateCall?.data.retryCount).toBe(5);
    const nextSendAt = updateCall?.data.nextSendAt as Date;
    expect(nextSendAt).toBeInstanceOf(Date);
    // 約 240 分後
    const deltaMin = (nextSendAt.getTime() - Date.now()) / 60_000;
    expect(deltaMin).toBeGreaterThan(239);
    expect(deltaMin).toBeLessThan(241);
  });

  it('複数行を一括処理 (成功 + 失敗 混在)', async () => {
    vi.mocked(prisma.stripeUsageRecordQueue.findMany).mockResolvedValue([
      buildQueueRow({ id: 'row-1' }),
      buildQueueRow({ id: 'row-2' }),
      buildQueueRow({ id: 'row-3' }),
    ] as never);
    vi.mocked(prisma.stripeUsageRecordQueue.update).mockResolvedValue({} as never);
    mockReportUsage
      .mockResolvedValueOnce({ ok: true, value: {} })
      .mockResolvedValueOnce({ ok: false, code: 'rate_limit', retryAfterSec: 5, userMessage: 'rl' })
      .mockResolvedValueOnce({ ok: true, value: {} });

    const result = await flushStripeUsageRecordQueue();

    expect(result.candidates).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.dlq).toBe(0);
  });
});
