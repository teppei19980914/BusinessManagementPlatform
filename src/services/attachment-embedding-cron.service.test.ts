/**
 * attachment-embedding-cron.service の単体テスト (ADR-0021)
 *
 * 検証観点:
 *   - isReadyForRetry: 指数 backoff (1 / 5 / 30min) スケジュール判定
 *   - processAttachmentEmbeddingQueue:
 *       * pending fetch + backoff filter
 *       * download → extract → embed の正常系
 *       * 各 kind (success / throttled / failed_will_retry / failed_permanent / unsupported)
 *       * download 失敗時の retry counter increment
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    attachment: {
      findMany: vi.fn(),
      update: vi.fn(),
      // ADR-0021 (2026-05-26) KDD §5.X+145: atomic claim 用 updateMany
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/supabase-storage', () => ({
  downloadObject: vi.fn(),
}));

vi.mock('@/services/file-text-extraction.service', () => ({
  extractText: vi.fn(),
}));

vi.mock('@/services/attachment-embedding.service', () => ({
  embedAttachment: vi.fn(),
}));

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));

import {
  isReadyForRetry,
  processAttachmentEmbeddingQueue,
  ATTACHMENT_EMBEDDING_BATCH_SIZE,
} from './attachment-embedding-cron.service';
import { prisma } from '@/lib/db';
import { downloadObject } from '@/lib/supabase-storage';
import { extractText } from '@/services/file-text-extraction.service';
import { embedAttachment } from '@/services/attachment-embedding.service';

const TENANT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  // ADR-0021 (2026-05-26) KDD §5.X+145: 各テストで atomic claim 成功をデフォルトに
  vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 1 } as never);
});

describe('isReadyForRetry — 指数 backoff', () => {
  const now = new Date('2026-05-26T10:00:00Z');

  it('retryCount=0 (未試行) → 常に true', () => {
    expect(isReadyForRetry(0, null, now)).toBe(true);
    expect(isReadyForRetry(0, new Date(now.getTime() - 1000), now)).toBe(true);
  });

  it('retryCount=1: lastRetryAt + 1min 未経過 → false', () => {
    const last = new Date(now.getTime() - 30 * 1000);
    expect(isReadyForRetry(1, last, now)).toBe(false);
  });

  it('retryCount=1: lastRetryAt + 1min 経過 → true', () => {
    const last = new Date(now.getTime() - 60 * 1000);
    expect(isReadyForRetry(1, last, now)).toBe(true);
  });

  it('retryCount=2: lastRetryAt + 5min 未経過 → false', () => {
    const last = new Date(now.getTime() - 3 * 60 * 1000);
    expect(isReadyForRetry(2, last, now)).toBe(false);
  });

  it('retryCount=2: lastRetryAt + 5min 経過 → true', () => {
    const last = new Date(now.getTime() - 5 * 60 * 1000);
    expect(isReadyForRetry(2, last, now)).toBe(true);
  });

  it('retryCount=3 (= max 超) → false (= もうリトライしない)', () => {
    const last = new Date(now.getTime() - 60 * 60 * 1000);
    expect(isReadyForRetry(3, last, now)).toBe(false);
  });
});

describe('processAttachmentEmbeddingQueue', () => {
  const baseAttachment = {
    id: 'att-1',
    tenantId: TENANT_ID,
    storageObjectKey: `tenants/${TENANT_ID}/project/x/uuid-spec.pdf`,
    url: `tenants/${TENANT_ID}/project/x/uuid-spec.pdf`,
    displayName: 'spec.pdf',
    embeddingStatus: 'pending', // KDD §5.X+145: stale recovery 判定で必要
    embeddingRetryCount: 0,
    embeddingLastRetryAt: null,
  };

  it('正常系: 1 件成功で succeeded=1', async () => {
    vi.mocked(prisma.attachment.findMany).mockResolvedValueOnce([baseAttachment] as never);
    vi.mocked(downloadObject).mockResolvedValueOnce(Buffer.from('pdf bytes'));
    vi.mocked(extractText).mockResolvedValueOnce({
      kind: 'success',
      text: 'extracted text',
      sha256: 'sha-abc',
      sourceFormat: 'pdf',
    });
    vi.mocked(embedAttachment).mockResolvedValueOnce({ kind: 'success' });

    const r = await processAttachmentEmbeddingQueue();

    expect(r.processed).toBe(1);
    expect(r.succeeded).toBe(1);
    expect(r.failed).toBe(0);
    expect(embedAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentId: 'att-1',
        tenantId: TENANT_ID,
        text: 'extracted text',
      }),
    );
  });

  it('extractText.unsupported → embeddingStatus="unsupported" + 集計', async () => {
    vi.mocked(prisma.attachment.findMany).mockResolvedValueOnce([baseAttachment] as never);
    vi.mocked(downloadObject).mockResolvedValueOnce(Buffer.from('binary'));
    vi.mocked(extractText).mockResolvedValueOnce({
      kind: 'unsupported',
      reason: 'extension not supported',
    });

    const r = await processAttachmentEmbeddingQueue();

    expect(r.unsupported).toBe(1);
    expect(prisma.attachment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'att-1' },
        data: { embeddingStatus: 'unsupported' },
      }),
    );
  });

  it('extractText.error → retry counter increment + pending 戻し', async () => {
    vi.mocked(prisma.attachment.findMany).mockResolvedValueOnce([baseAttachment] as never);
    vi.mocked(downloadObject).mockResolvedValueOnce(Buffer.from('corrupt'));
    vi.mocked(extractText).mockResolvedValueOnce({
      kind: 'error',
      error: 'pdf parse failed',
      sourceFormat: 'pdf',
    });

    const r = await processAttachmentEmbeddingQueue();

    expect(r.willRetry).toBe(1);
    expect(prisma.attachment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          embeddingStatus: 'pending',
          embeddingRetryCount: 1,
        }),
      }),
    );
  });

  it('extractText.error で retryCount=2 → failed 確定', async () => {
    vi.mocked(prisma.attachment.findMany).mockResolvedValueOnce([
      { ...baseAttachment, embeddingRetryCount: 2, embeddingLastRetryAt: null },
    ] as never);
    vi.mocked(downloadObject).mockResolvedValueOnce(Buffer.from('corrupt'));
    vi.mocked(extractText).mockResolvedValueOnce({
      kind: 'error',
      error: 'pdf parse failed',
      sourceFormat: 'pdf',
    });

    const r = await processAttachmentEmbeddingQueue();

    expect(r.failed).toBe(1);
    expect(prisma.attachment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          embeddingStatus: 'failed',
          embeddingRetryCount: 3,
        }),
      }),
    );
  });

  it('embedAttachment.throttled → throttled count', async () => {
    vi.mocked(prisma.attachment.findMany).mockResolvedValueOnce([baseAttachment] as never);
    vi.mocked(downloadObject).mockResolvedValueOnce(Buffer.from('pdf'));
    vi.mocked(extractText).mockResolvedValueOnce({
      kind: 'success',
      text: 'extracted',
      sha256: 'sha',
      sourceFormat: 'pdf',
    });
    vi.mocked(embedAttachment).mockResolvedValueOnce({ kind: 'throttled' });

    const r = await processAttachmentEmbeddingQueue();

    expect(r.throttled).toBe(1);
  });

  it('downloadObject 失敗 → retry counter increment + recordError', async () => {
    vi.mocked(prisma.attachment.findMany).mockResolvedValueOnce([baseAttachment] as never);
    vi.mocked(downloadObject).mockRejectedValueOnce(new Error('storage 5xx'));

    const r = await processAttachmentEmbeddingQueue();

    expect(r.willRetry).toBe(1);
    expect(prisma.attachment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          embeddingStatus: 'pending',
          embeddingRetryCount: 1,
        }),
      }),
    );
  });

  it('backoff 未経過の attachment はスキップ', async () => {
    const recentRetry = new Date(Date.now() - 10 * 1000); // 10s 前 retry
    vi.mocked(prisma.attachment.findMany).mockResolvedValueOnce([
      {
        ...baseAttachment,
        embeddingRetryCount: 1, // 1min backoff、まだ 10s しか経ってない
        embeddingLastRetryAt: recentRetry,
      },
    ] as never);

    const r = await processAttachmentEmbeddingQueue();

    expect(r.processed).toBe(0);
    expect(downloadObject).not.toHaveBeenCalled();
  });

  it('storageObjectKey 欠落 → unsupported (= データ不整合)', async () => {
    vi.mocked(prisma.attachment.findMany).mockResolvedValueOnce([
      { ...baseAttachment, storageObjectKey: null, url: '' },
    ] as never);

    const r = await processAttachmentEmbeddingQueue();

    expect(r.unsupported).toBe(1);
    expect(downloadObject).not.toHaveBeenCalled();
  });

  it('BATCH_SIZE で処理を打ち切る', async () => {
    const many = Array.from({ length: ATTACHMENT_EMBEDDING_BATCH_SIZE + 5 }, (_, i) => ({
      ...baseAttachment,
      id: `att-${i}`,
    }));
    vi.mocked(prisma.attachment.findMany).mockResolvedValueOnce(many as never);
    vi.mocked(downloadObject).mockResolvedValue(Buffer.from('pdf'));
    vi.mocked(extractText).mockResolvedValue({
      kind: 'success',
      text: 'x',
      sha256: 's',
      sourceFormat: 'pdf',
    });
    vi.mocked(embedAttachment).mockResolvedValue({ kind: 'success' });

    const r = await processAttachmentEmbeddingQueue();

    expect(r.processed).toBe(ATTACHMENT_EMBEDDING_BATCH_SIZE);
    expect(r.succeeded).toBe(ATTACHMENT_EMBEDDING_BATCH_SIZE);
  });
});
