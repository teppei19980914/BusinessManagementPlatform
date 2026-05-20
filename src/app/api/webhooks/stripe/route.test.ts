/**
 * /api/webhooks/stripe POST の単体テスト (PR-S4 / 2026-05-14)
 *
 * 検証観点:
 *   1. STRIPE_ENABLED=false → 503 STRIPE_DISABLED
 *   2. stripe-signature ヘッダ欠如 → 400 MISSING_SIGNATURE
 *   3. constructEvent throw → 400 INVALID_SIGNATURE
 *   4. 既に processedAt != null の event → 200 already_processed (= 冪等性)
 *   5. 正常系: handler dispatch → processedAt 更新 → 200 processed
 *   6. handler throw → errorMessage 記録 + retryCount++ + 500
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Prisma モック
// feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S2-C1-Stripe):
//   route が findUnique+create から upsert に変更されたため、upsert を mock 追加。
//   findUnique/create は他経路で残っているため互換性のため維持。
vi.mock('@/lib/db', () => ({
  prisma: {
    stripeWebhookEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

// Stripe lib モック (= feature flag + webhook secret + client)
const mockConstructEvent = vi.fn();
const mockGetStripe = vi.fn(() => ({
  webhooks: { constructEvent: mockConstructEvent },
}));
let stripeEnabled = true;

vi.mock('@/lib/stripe', () => ({
  isStripeEnabled: () => stripeEnabled,
  getStripe: () => mockGetStripe(),
  getStripeWebhookSecret: () => 'whsec_test_secret',
}));

// dispatcher モック (= service 層に依存しない)
const mockDispatch = vi.fn();
vi.mock('@/services/stripe-webhook-handlers.service', () => ({
  dispatchStripeWebhookEvent: (event: unknown) => mockDispatch(event),
}));

import { prisma } from '@/lib/db';
import { POST } from './route';

function buildRequest(body: string, signature: string | null = 't=123,v1=abc'): Request {
  const headers = new Headers();
  if (signature != null) headers.set('stripe-signature', signature);
  return new Request('https://example.com/api/webhooks/stripe', {
    method: 'POST',
    headers,
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stripeEnabled = true;
});

describe('POST /api/webhooks/stripe', () => {
  it('STRIPE_ENABLED=false → 503 STRIPE_DISABLED', async () => {
    stripeEnabled = false;
    const res = await POST(buildRequest('{}') as never);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error.code).toBe('STRIPE_DISABLED');
  });

  it('stripe-signature ヘッダなし → 400 MISSING_SIGNATURE', async () => {
    const res = await POST(buildRequest('{}', null) as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('MISSING_SIGNATURE');
  });

  it('signature 検証 throw → 400 INVALID_SIGNATURE', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('No matching signature found');
    });
    const res = await POST(buildRequest('{}') as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('INVALID_SIGNATURE');
    expect(json.error.message).toContain('No matching signature');
  });

  // feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S2-C1-Stripe):
  //   route が findUnique+create から upsert に変更されたため、すべての test で
  //   upsert を mock する。upsert は「既存があれば既存行 / 無ければ新規作成行」を返す。
  it('既存 event で processedAt != null → 200 already_processed (= 冪等性)', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_dup', type: 'customer.subscription.updated', data: { object: {} } });
    vi.mocked(prisma.stripeWebhookEvent.upsert).mockResolvedValue({
      id: 'evt_dup',
      processedAt: new Date(),
      retryCount: 0,
    } as never);

    const res = await POST(buildRequest('{}') as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe('already_processed');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('新規 event → upsert + dispatch + processedAt 更新 → 200 processed', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_new', type: 'invoice.paid', data: { object: {} } });
    vi.mocked(prisma.stripeWebhookEvent.upsert).mockResolvedValue({
      id: 'evt_new',
      processedAt: null,
      retryCount: 0,
    } as never);
    vi.mocked(prisma.stripeWebhookEvent.update).mockResolvedValue({} as never);
    mockDispatch.mockResolvedValue({ ok: true, action: 'invoice_paid' });

    const res = await POST(buildRequest('{}') as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe('processed');
    expect(json.data.action).toBe('invoice_paid');

    // upsert が呼ばれた
    const upsertCall = vi.mocked(prisma.stripeWebhookEvent.upsert).mock.calls[0]?.[0];
    expect(upsertCall?.where).toEqual({ id: 'evt_new' });

    // update の processedAt がセットされた
    const updateCall = vi.mocked(prisma.stripeWebhookEvent.update).mock.calls[0]?.[0];
    expect(updateCall?.where).toEqual({ id: 'evt_new' });
    expect(updateCall?.data.processedAt).toBeInstanceOf(Date);
    expect(updateCall?.data.errorMessage).toBeNull();
  });

  it('handler throw → errorMessage 記録 + retryCount=1 + 500', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_fail', type: 'invoice.paid', data: { object: {} } });
    vi.mocked(prisma.stripeWebhookEvent.upsert).mockResolvedValue({
      id: 'evt_fail',
      processedAt: null,
      retryCount: 0,
    } as never);
    vi.mocked(prisma.stripeWebhookEvent.update).mockResolvedValue({} as never);
    mockDispatch.mockRejectedValue(new Error('DB connection lost'));

    const res = await POST(buildRequest('{}') as never);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.code).toBe('WEBHOOK_HANDLER_ERROR');
    expect(json.error.message).toBe('DB connection lost');

    // update に errorMessage / retryCount=1 / nextRetryAt がセットされた
    const updateCall = vi.mocked(prisma.stripeWebhookEvent.update).mock.calls[0]?.[0];
    expect(updateCall?.data.errorMessage).toBe('DB connection lost');
    expect(updateCall?.data.retryCount).toBe(1);
    expect(updateCall?.data.nextRetryAt).toBeInstanceOf(Date);
  });

  it('既存 event で processedAt=null かつ retryCount=3 → handler 再実行で retryCount=4 + nextRetryAt=null (= DLQ)', async () => {
    mockConstructEvent.mockReturnValue({ id: 'evt_retry', type: 'invoice.paid', data: { object: {} } });
    vi.mocked(prisma.stripeWebhookEvent.upsert).mockResolvedValue({
      id: 'evt_retry',
      processedAt: null,
      retryCount: 3,
    } as never);
    vi.mocked(prisma.stripeWebhookEvent.update).mockResolvedValue({} as never);
    mockDispatch.mockRejectedValue(new Error('Still failing'));

    const res = await POST(buildRequest('{}') as never);
    expect(res.status).toBe(500);

    // retryCount は既存 3 → 4 へ
    const updateCall = vi.mocked(prisma.stripeWebhookEvent.update).mock.calls[0]?.[0];
    expect(updateCall?.data.retryCount).toBe(4);
    // 4 回目で nextRetryAt=null (= DLQ)
    expect(updateCall?.data.nextRetryAt).toBeNull();
  });
});
