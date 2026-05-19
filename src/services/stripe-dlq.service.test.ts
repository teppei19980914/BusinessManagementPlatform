/**
 * stripe-dlq.service の単体テスト (PR-V7 #6 / 2026-05-19)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    stripeWebhookEvent: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    stripeUsageRecordQueue: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

import { prisma } from '@/lib/db';
import {
  listWebhookDlq,
  listUsageQueueDlq,
  retryWebhookEvent,
  retryUsageQueueRow,
} from './stripe-dlq.service';

const SUPER_ADMIN_ID = 'super-admin-uuid';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listWebhookDlq', () => {
  it('未処理 webhook event を retryCount 高順で返却', async () => {
    vi.mocked(prisma.stripeWebhookEvent.findMany).mockResolvedValue([
      {
        id: 'evt_dlq',
        type: 'invoice.paid',
        receivedAt: new Date(),
        processedAt: null,
        errorMessage: 'persistent failure',
        retryCount: 5,
        nextRetryAt: null,
      },
      {
        id: 'evt_pending',
        type: 'invoice.created',
        receivedAt: new Date(),
        processedAt: null,
        errorMessage: null,
        retryCount: 1,
        nextRetryAt: new Date(),
      },
    ] as never);

    const result = await listWebhookDlq();

    expect(result.entries.length).toBe(2);
    expect(result.totalDlq).toBe(1);
    expect(result.totalUnprocessed).toBe(1);
    expect(result.entries[0]?.isDlq).toBe(true);
    expect(result.entries[1]?.isDlq).toBe(false);
  });
});

describe('listUsageQueueDlq', () => {
  it('未送信 queue 行を返却', async () => {
    vi.mocked(prisma.stripeUsageRecordQueue.findMany).mockResolvedValue([
      {
        id: 'queue_dlq',
        tenantId: 'tenant-1',
        callType: 'haiku',
        apiCallLogId: 'log-1',
        quantity: 1,
        occurredAt: new Date(),
        retryCount: 6,
        nextSendAt: null,
        sentAt: null,
        lastError: 'persistent failure',
      },
    ] as never);

    const result = await listUsageQueueDlq();

    expect(result.entries.length).toBe(1);
    expect(result.totalDlq).toBe(1);
    expect(result.entries[0]?.isDlq).toBe(true);
  });
});

describe('retryWebhookEvent', () => {
  it('未処理 event → retryCount/nextRetryAt リセット + auditLog', async () => {
    vi.mocked(prisma.stripeWebhookEvent.findUnique).mockResolvedValue({
      id: 'evt_xxx',
      processedAt: null,
      type: 'invoice.paid',
      retryCount: 5,
    } as never);
    vi.mocked(prisma.stripeWebhookEvent.update).mockResolvedValue({} as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);

    const result = await retryWebhookEvent('evt_xxx', SUPER_ADMIN_ID);

    expect(result.ok).toBe(true);
    const updateCall = vi.mocked(prisma.stripeWebhookEvent.update).mock.calls[0]?.[0];
    expect(updateCall?.data.retryCount).toBe(0);
    expect(updateCall?.data.nextRetryAt).toBeInstanceOf(Date);
    expect(updateCall?.data.errorMessage).toBeNull();

    const auditCall = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0];
    expect(auditCall?.data.afterValue).toMatchObject({
      action: 'dlq_manual_retry',
      eventType: 'invoice.paid',
    });
  });

  it('event 不在 → EVENT_NOT_FOUND', async () => {
    vi.mocked(prisma.stripeWebhookEvent.findUnique).mockResolvedValue(null);
    const result = await retryWebhookEvent('evt_missing', SUPER_ADMIN_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('EVENT_NOT_FOUND');
  });

  it('既処理 event → ALREADY_PROCESSED', async () => {
    vi.mocked(prisma.stripeWebhookEvent.findUnique).mockResolvedValue({
      id: 'evt_done',
      processedAt: new Date(),
      type: 'invoice.paid',
      retryCount: 0,
    } as never);
    const result = await retryWebhookEvent('evt_done', SUPER_ADMIN_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('ALREADY_PROCESSED');
  });
});

describe('retryUsageQueueRow', () => {
  it('未送信 row → retryCount/nextSendAt リセット + auditLog', async () => {
    vi.mocked(prisma.stripeUsageRecordQueue.findUnique).mockResolvedValue({
      id: 'queue_xxx',
      tenantId: 'tenant-1',
      sentAt: null,
      retryCount: 6,
      apiCallLogId: 'log-1',
    } as never);
    vi.mocked(prisma.stripeUsageRecordQueue.update).mockResolvedValue({} as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);

    const result = await retryUsageQueueRow('queue_xxx', SUPER_ADMIN_ID);

    expect(result.ok).toBe(true);
    const updateCall = vi.mocked(prisma.stripeUsageRecordQueue.update).mock.calls[0]?.[0];
    expect(updateCall?.data.retryCount).toBe(0);
    expect(updateCall?.data.nextSendAt).toBeInstanceOf(Date);
    expect(updateCall?.data.lastError).toBeNull();
  });

  it('row 不在 → ROW_NOT_FOUND', async () => {
    vi.mocked(prisma.stripeUsageRecordQueue.findUnique).mockResolvedValue(null);
    const result = await retryUsageQueueRow('missing', SUPER_ADMIN_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('ROW_NOT_FOUND');
  });

  it('既送信 row → ALREADY_SENT', async () => {
    vi.mocked(prisma.stripeUsageRecordQueue.findUnique).mockResolvedValue({
      id: 'queue_done',
      tenantId: 'tenant-1',
      sentAt: new Date(),
      retryCount: 0,
      apiCallLogId: 'log-1',
    } as never);
    const result = await retryUsageQueueRow('queue_done', SUPER_ADMIN_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('ALREADY_SENT');
  });
});
