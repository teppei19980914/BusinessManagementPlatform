/**
 * POST /api/attachments/upload — Pre-signed URL 発行ルートのテスト (ADR-0021)
 *
 * 検証観点:
 *   - 認証なし → 401
 *   - validation エラー → 400
 *   - 危険拡張子 → 400 DANGEROUS_FILE_TYPE
 *   - 50MB 超 → 413
 *   - 認可失敗 → 403 / 404
 *   - Beginner 無料枠超過 (precheck) → 403 BEGINNER_STORAGE_QUOTA_EXCEEDED
 *     (2026-05-31: 50GB 累積ハードキャップは撤去 ADR-0030)
 *   - 正常系 → 200 + uploadUrl / token / objectKey
 *   - rate limit → 429
 *   - Supabase 失敗 → 503
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  applySubjectRateLimit: vi.fn(() => null),
}));

vi.mock('@/services/attachment.service', () => ({
  authorizeForAttachmentEntity: vi.fn(),
}));

vi.mock('@/services/storage-guard.service', () => ({
  precheckFileStorageLimit: vi.fn(),
}));

vi.mock('@/lib/supabase-storage', () => ({
  createSignedUploadUrl: vi.fn(),
}));

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));

import { POST } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { applySubjectRateLimit } from '@/lib/rate-limit';
import { authorizeForAttachmentEntity } from '@/services/attachment.service';
import { precheckFileStorageLimit } from '@/services/storage-guard.service';
import { createSignedUploadUrl } from '@/lib/supabase-storage';
import { BEGINNER_STORAGE_FREE_TIER_BYTES } from '@/config/file-storage-pricing';

const TENANT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const USER = {
  id: 'u-1',
  tenantId: TENANT_ID,
  name: 'Alice',
  email: 'a@x.com',
  systemRole: 'general',
};
const ENTITY_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://x/api/attachments/upload', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const validBody = {
  entityType: 'project',
  entityId: ENTITY_ID,
  fileName: 'spec.pdf',
  sizeBytes: 1_000_000,
  mimeType: 'application/pdf',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthenticatedUser).mockResolvedValue(USER as never);
  vi.mocked(applySubjectRateLimit).mockReturnValue(null);
  vi.mocked(authorizeForAttachmentEntity).mockResolvedValue({ ok: true } as never);
  vi.mocked(precheckFileStorageLimit).mockResolvedValue({
    ok: true,
    cachedUsedBytes: 0,
    limitBytes: BEGINNER_STORAGE_FREE_TIER_BYTES,
  });
  vi.mocked(createSignedUploadUrl).mockResolvedValue({
    signedUrl: 'https://example.supabase.co/storage/v1/object/upload/sign/attachments/x?token=t',
    token: 'tok',
    path: 'tenants/x/project/y/uuid-spec.pdf',
  });
});

describe('POST /api/attachments/upload', () => {
  it('認証なし → 401', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValueOnce(
      NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }) as never,
    );
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(401);
  });

  it('rate limit 超過 → 429', async () => {
    vi.mocked(applySubjectRateLimit).mockReturnValueOnce(
      NextResponse.json({ error: { code: 'TOO_MANY_REQUESTS' } }, { status: 429 }),
    );
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(429);
  });

  it('validation エラー (sizeBytes 0) → 400', async () => {
    const res = await POST(makeReq({ ...validBody, sizeBytes: 0 }));
    expect(res.status).toBe(400);
  });

  it('危険拡張子 (.exe) → 400 DANGEROUS_FILE_TYPE', async () => {
    const res = await POST(makeReq({ ...validBody, fileName: 'malware.exe' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('DANGEROUS_FILE_TYPE');
  });

  it('50MB 超 → 400 (validator 段階で reject)', async () => {
    const res = await POST(makeReq({ ...validBody, sizeBytes: 60 * 1_000_000 }));
    expect(res.status).toBe(400);
  });

  it('認可失敗 (entity not found) → 404', async () => {
    vi.mocked(authorizeForAttachmentEntity).mockResolvedValueOnce({
      ok: false,
      status: 404,
      code: 'NOT_FOUND',
    } as never);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(404);
  });

  it('認可失敗 (forbidden) → 403', async () => {
    vi.mocked(authorizeForAttachmentEntity).mockResolvedValueOnce({
      ok: false,
      status: 403,
      code: 'FORBIDDEN',
    } as never);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(403);
  });

  it('Beginner 無料枠超過 (precheck NG) → 403 BEGINNER_STORAGE_QUOTA_EXCEEDED', async () => {
    vi.mocked(precheckFileStorageLimit).mockResolvedValueOnce({
      ok: false,
      code: 'BEGINNER_STORAGE_QUOTA_EXCEEDED',
      cachedUsedBytes: BEGINNER_STORAGE_FREE_TIER_BYTES,
      limitBytes: BEGINNER_STORAGE_FREE_TIER_BYTES,
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('BEGINNER_STORAGE_QUOTA_EXCEEDED');
  });

  it('Supabase 発行失敗 → 503', async () => {
    vi.mocked(createSignedUploadUrl).mockRejectedValueOnce(new Error('supabase 5xx'));
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(503);
  });

  it('正常系 → 200 + uploadUrl / objectKey / sanitizedFileName', async () => {
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.uploadUrl).toContain('storage/v1');
    expect(body.data.objectKey).toContain('tenants/');
    expect(body.data.sanitizedFileName).toBe('spec.pdf');
    expect(body.data.expiresInSeconds).toBe(60);
  });

  it('path traversal を含むファイル名は sanitize される', async () => {
    const res = await POST(makeReq({ ...validBody, fileName: '../etc/passwd' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.sanitizedFileName).not.toContain('..');
  });
});
