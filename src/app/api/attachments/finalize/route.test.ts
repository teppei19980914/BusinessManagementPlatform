/**
 * POST /api/attachments/finalize — Attachment row 確定ルートのテスト (ADR-0021)
 *
 * 検証観点:
 *   - 認証なし → 401
 *   - validation エラー → 400
 *   - tenant prefix 不一致 (越境試行) → 400 INVALID_OBJECT_KEY
 *   - 危険拡張子 → 400 + Supabase オブジェクト削除
 *   - 認可失敗 → 403/404 + Supabase オブジェクト削除
 *   - オブジェクト不在 → 404
 *   - 実サイズ 50MB 超 → 413 + Supabase オブジェクト削除
 *   - ハードキャップ超過 → 403 + Supabase オブジェクト削除
 *   - 正常系 → 201 + attachment 返却 + embeddingStatus='pending'/'unsupported'
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    $transaction: vi.fn(),
  },
}));

vi.mock('@/services/attachment.service', () => ({
  authorizeForAttachmentEntity: vi.fn(),
}));

vi.mock('@/services/storage-guard.service', async () => {
  const actual = await vi.importActual<typeof import('@/services/storage-guard.service')>(
    '@/services/storage-guard.service',
  );
  return {
    ...actual,
    assertFileStorageLimitInTx: vi.fn(),
  };
});

vi.mock('@/lib/supabase-storage', () => ({
  getObjectInfo: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock('@/services/audit.service', () => ({
  recordAuditLog: vi.fn(),
}));

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

import { POST } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { authorizeForAttachmentEntity } from '@/services/attachment.service';
import { BeginnerWriteGuardExceededError } from '@/services/storage-guard.service';
import { deleteObject, getObjectInfo } from '@/lib/supabase-storage';
import { BEGINNER_STORAGE_FREE_TIER_BYTES } from '@/config/file-storage-pricing';

const TENANT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const ENTITY_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const USER = {
  id: 'u-1',
  tenantId: TENANT_ID,
  name: 'Alice',
  email: 'a@x.com',
  systemRole: 'general',
};

const validObjectKey = `tenants/${TENANT_ID}/project/${ENTITY_ID}/uuid-spec.pdf`;
const validBody = {
  entityType: 'project',
  entityId: ENTITY_ID,
  objectKey: validObjectKey,
  fileName: 'spec.pdf',
  displayName: 'プロジェクト仕様',
  sizeBytes: 1_000_000,
  mimeType: 'application/pdf',
};

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://x/api/attachments/finalize', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthenticatedUser).mockResolvedValue(USER as never);
  vi.mocked(authorizeForAttachmentEntity).mockResolvedValue({ ok: true } as never);
  vi.mocked(getObjectInfo).mockResolvedValue({
    size: 1_000_000,
    contentType: 'application/pdf',
    lastModified: null,
  });
  vi.mocked(deleteObject).mockResolvedValue(undefined);
  vi.mocked(prisma.$transaction).mockImplementation(async (fn: unknown) => {
    if (typeof fn === 'function') {
      const tx = {
        attachment: {
          create: vi.fn().mockResolvedValue({
            id: 'att-1',
            entityType: 'project',
            entityId: ENTITY_ID,
            slot: 'general',
            displayName: 'プロジェクト仕様',
            mimeHint: 'application/pdf',
            sizeBytes: BigInt(1_000_000),
            storageObjectKey: validObjectKey,
            storageProvider: 'supabase',
            embeddingStatus: 'pending',
            addedBy: USER.id,
            addedByUser: { name: USER.name },
            createdAt: new Date('2026-05-26T00:00:00Z'),
          }),
        },
      };
      return (fn as (tx: unknown) => Promise<unknown>)(tx);
    }
    return undefined;
  });
});

describe('POST /api/attachments/finalize', () => {
  it('認証なし → 401', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValueOnce(
      NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }) as never,
    );
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(401);
  });

  it('validation エラー (sizeBytes 0) → 400', async () => {
    const res = await POST(makeReq({ ...validBody, sizeBytes: 0 }));
    expect(res.status).toBe(400);
  });

  it('tenant prefix 不一致 (越境試行) → 400 INVALID_OBJECT_KEY', async () => {
    const otherTenantKey = 'tenants/cccccccc-3333-4333-8333-333333333333/project/x/uuid-spec.pdf';
    const res = await POST(makeReq({ ...validBody, objectKey: otherTenantKey }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_OBJECT_KEY');
  });

  it('危険拡張子 → 400 + Storage オブジェクト削除', async () => {
    const evilBody = {
      ...validBody,
      fileName: 'malware.exe',
      objectKey: `tenants/${TENANT_ID}/project/${ENTITY_ID}/uuid-malware.exe`,
    };
    const res = await POST(makeReq(evilBody));
    expect(res.status).toBe(400);
    expect(deleteObject).toHaveBeenCalledWith(evilBody.objectKey);
  });

  it('認可失敗 → 403 + Storage オブジェクト削除', async () => {
    vi.mocked(authorizeForAttachmentEntity).mockResolvedValueOnce({
      ok: false,
      status: 403,
      code: 'FORBIDDEN',
    } as never);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(403);
    expect(deleteObject).toHaveBeenCalledWith(validObjectKey);
  });

  it('オブジェクト不在 → 404', async () => {
    vi.mocked(getObjectInfo).mockResolvedValueOnce(null);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('OBJECT_NOT_FOUND');
  });

  it('実サイズ 50MB 超 → 413 + Storage オブジェクト削除', async () => {
    vi.mocked(getObjectInfo).mockResolvedValueOnce({
      size: 60 * 1_000_000,
      contentType: 'application/pdf',
      lastModified: null,
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(413);
    expect(deleteObject).toHaveBeenCalledWith(validObjectKey);
  });

  it('Storage オブジェクト情報取得失敗 → 503', async () => {
    vi.mocked(getObjectInfo).mockRejectedValueOnce(new Error('supabase 5xx'));
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(503);
  });

  it('Beginner 無料枠超過 → 403 + Storage オブジェクト削除 (2026-05-31: 50GB 累積ハードキャップは撤去 ADR-0030)', async () => {
    vi.mocked(prisma.$transaction).mockImplementationOnce(async () => {
      throw new BeginnerWriteGuardExceededError({
        tenantId: TENANT_ID,
        quotaType: 'storage',
        currentBytes: BEGINNER_STORAGE_FREE_TIER_BYTES + 1,
        limitBytes: BEGINNER_STORAGE_FREE_TIER_BYTES,
      });
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(403);
    expect(deleteObject).toHaveBeenCalledWith(validObjectKey);
  });

  it('正常系 (pdf) → 201 + attachment with embeddingStatus="pending"', async () => {
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe('att-1');
    expect(body.data.storageProvider).toBe('supabase');
    expect(body.data.embeddingStatus).toBe('pending');
    expect(body.data.sizeBytes).toBe(1_000_000);
  });

  it('正常系 (png — 非対応拡張子) → 201 + embeddingStatus="unsupported"', async () => {
    // PNG は SUPPORTED ではない → finalize 内で 'unsupported' を渡し DB row 作成
    const pngObjectKey = `tenants/${TENANT_ID}/project/${ENTITY_ID}/uuid-photo.png`;
    const pngBody = {
      ...validBody,
      fileName: 'photo.png',
      mimeType: 'image/png',
      objectKey: pngObjectKey,
    };
    let observedStatus: string | undefined;
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn: unknown) => {
      const tx = {
        attachment: {
          create: vi.fn().mockImplementation(async (args: { data: { embeddingStatus: string } }) => {
            observedStatus = args.data.embeddingStatus;
            return {
              id: 'att-2',
              entityType: 'project',
              entityId: ENTITY_ID,
              slot: 'general',
              displayName: 'プロジェクト仕様',
              mimeHint: 'image/png',
              sizeBytes: BigInt(1_000_000),
              storageObjectKey: pngObjectKey,
              storageProvider: 'supabase',
              embeddingStatus: args.data.embeddingStatus,
              addedBy: USER.id,
              addedByUser: { name: USER.name },
              createdAt: new Date(),
            };
          }),
        },
      };
      return (fn as (tx: unknown) => Promise<unknown>)(tx);
    });

    vi.mocked(getObjectInfo).mockResolvedValueOnce({
      size: 1_000_000,
      contentType: 'image/png',
      lastModified: null,
    });

    const res = await POST(makeReq(pngBody));
    expect(res.status).toBe(201);
    expect(observedStatus).toBe('unsupported');
  });
});
