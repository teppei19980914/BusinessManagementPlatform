/**
 * ADR-0021 Scenario E: Attachment Embedding 全フロー integration test (2026-05-26)
 *
 * 検証範囲:
 *   upload 後 → cron が pending を拾う → download → extractText → embed → 'completed' に遷移
 *   までを 1 連の orchestration として検証する。
 *
 * 個別ロジックは各 service の unit test で網羅済 (file-text-extraction / attachment-embedding /
 * supabase-storage / storage-guard / bucket-usage / cron-service)。本 test は **境界をまたぐ
 * データ受け渡し** に絞って検証する (= 個別 mock では検出できない型不整合や順序問題)。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    attachment: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      // ADR-0021 (2026-05-26) KDD §5.X+145: atomic claim
      updateMany: vi.fn(),
    },
    $executeRaw: vi.fn(),
  },
}));

vi.mock('@/lib/supabase-storage', () => ({
  downloadObject: vi.fn(),
}));

vi.mock('@/services/embedding.service', () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));

import { processAttachmentEmbeddingQueue } from '@/services/attachment-embedding-cron.service';
import { _resetEmbeddingConcurrencyForTest } from '@/services/attachment-embedding.service';
import { prisma } from '@/lib/db';
import { downloadObject } from '@/lib/supabase-storage';
import { generateEmbedding } from '@/services/embedding.service';

const TENANT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  _resetEmbeddingConcurrencyForTest();
  // ADR-0021 (2026-05-26) KDD §5.X+145: atomic claim 成功をデフォルトに
  vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 1 } as never);
});

describe('Scenario E: Attachment Embedding 全フロー', () => {
  it('upload→cron→completed: PDF をアップロード後、cron が拾って embedding を生成し DB を更新する', async () => {
    // 前提: finalize で Attachment row が 'pending' で作成済 (= unit test で別途検証)
    const pendingAttachment = {
      id: 'att-1',
      tenantId: TENANT_ID,
      storageObjectKey: `tenants/${TENANT_ID}/project/x/uuid-spec.pdf`,
      url: `tenants/${TENANT_ID}/project/x/uuid-spec.pdf`,
      displayName: 'プロジェクト仕様書.pdf',
      embeddingStatus: 'pending', embeddingRetryCount: 0,
      embeddingLastRetryAt: null,
    };

    vi.mocked(prisma.attachment.findMany).mockResolvedValueOnce([pendingAttachment] as never);

    // 1. Supabase Storage からダウンロード成功
    //    Buffer 内容は最小限の PDF 風データ (実際の parse は extractText でモック化されるため
    //    バイナリ内容は問わない)
    vi.mocked(downloadObject).mockResolvedValueOnce(Buffer.from('%PDF-1.4\nfake pdf bytes\n%%EOF'));

    // 2. file-text-extraction: PDF parser を外部から差し替えてテキスト抽出成功させる
    const { _setExtractorsForTest } = await import('@/services/file-text-extraction.service');
    _setExtractorsForTest({
      pdf: async () => ({ text: 'プロジェクトの目的は新規顧客獲得である。' }),
    });

    // 3. embedding 生成: Voyage 1024 次元 mock を返す
    vi.mocked(generateEmbedding).mockResolvedValueOnce({
      ok: true,
      embedding: new Array(1024).fill(0.001),
      tokenCount: 30,
    } as never);

    // 4. cron を実行
    const result = await processAttachmentEmbeddingQueue();

    // 検証: 1 件成功
    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    // 受け渡し: download → extract → embed → DB UPDATE の鎖が成立
    expect(downloadObject).toHaveBeenCalledWith(pendingAttachment.storageObjectKey);
    expect(generateEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'プロジェクトの目的は新規顧客獲得である。',
        featureUnit: 'attachment-embedding',
        tenantId: TENANT_ID,
        inputType: 'document',
      }),
    );
    // raw SQL UPDATE (embedding='completed') が呼ばれる
    expect(prisma.$executeRaw).toHaveBeenCalled();

    // cleanup
    _setExtractorsForTest({ pdf: null });
  });

  it('画像 (unsupported) → cron が拾って "unsupported" 確定 (= Voyage 呼出ゼロ)', async () => {
    const imageAttachment = {
      id: 'att-2',
      tenantId: TENANT_ID,
      storageObjectKey: `tenants/${TENANT_ID}/project/x/uuid-photo.jpg`,
      url: `tenants/${TENANT_ID}/project/x/uuid-photo.jpg`,
      displayName: 'photo.jpg',
      embeddingStatus: 'pending', embeddingRetryCount: 0,
      embeddingLastRetryAt: null,
    };

    vi.mocked(prisma.attachment.findMany).mockResolvedValueOnce([imageAttachment] as never);
    vi.mocked(downloadObject).mockResolvedValueOnce(Buffer.from([0xff, 0xd8, 0xff])); // JPEG magic

    const result = await processAttachmentEmbeddingQueue();

    expect(result.unsupported).toBe(1);
    expect(result.processed).toBe(1);
    // Voyage は呼ばれない (= 無料 API 枠を浪費しない)
    expect(generateEmbedding).not.toHaveBeenCalled();
    // status='unsupported' に更新される
    expect(prisma.attachment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'att-2' },
        data: { embeddingStatus: 'unsupported' },
      }),
    );
  });

  it('Voyage rate limit → failed_will_retry + リトライ counter 進行', async () => {
    const pendingAttachment = {
      id: 'att-3',
      tenantId: TENANT_ID,
      storageObjectKey: `tenants/${TENANT_ID}/project/x/uuid-spec.pdf`,
      url: `tenants/${TENANT_ID}/project/x/uuid-spec.pdf`,
      displayName: 'spec.pdf',
      embeddingStatus: 'pending', embeddingRetryCount: 0,
      embeddingLastRetryAt: null,
    };

    vi.mocked(prisma.attachment.findMany).mockResolvedValueOnce([pendingAttachment] as never);
    vi.mocked(downloadObject).mockResolvedValueOnce(Buffer.from('pdf'));

    const { _setExtractorsForTest } = await import('@/services/file-text-extraction.service');
    _setExtractorsForTest({
      pdf: async () => ({ text: 'text content' }),
    });

    // generateEmbedding が縮退モード reason='rate_limited' を返す
    vi.mocked(generateEmbedding).mockResolvedValueOnce({
      ok: false,
      reason: 'rate_limited',
      message: 'Voyage rate limit exceeded',
    } as never);

    // attachment-embedding.service の handleFailure 内で retryCount 取得用 findUnique を mock
    vi.mocked(prisma.attachment.findUnique).mockResolvedValueOnce({
      embeddingStatus: 'pending', embeddingRetryCount: 0,
    } as never);

    const result = await processAttachmentEmbeddingQueue();

    expect(result.willRetry).toBe(1);
    expect(result.succeeded).toBe(0);

    _setExtractorsForTest({ pdf: null });
  });
});
