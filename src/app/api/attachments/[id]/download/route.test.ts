/**
 * /api/attachments/[id]/download route 単体テスト
 *   security/phase-2 (2026-05-31)
 *
 * 重点:
 *   1. 認証失敗で 401
 *   2. attachment 不在 (= 越境試行含む) で 404
 *   3. 成功時に downloadFilename=displayName を createSignedDownloadUrl に渡す
 *      (= Content-Disposition: attachment; filename="..." 強制 = SVG/HTML XSS 経路遮断 主防御)
 *   4. displayName=null の場合は downloadFilename=undefined で渡る (download=true のみ)
 *   5. legacy url 型はそのまま url を 302 redirect (downloadFilename 不適用)
 *   6. signedUrl 発行失敗時に 503 と recordError 呼出
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  prisma: { attachment: { findFirst: vi.fn() } },
}));
vi.mock('@/services/attachment.service', () => ({
  authorizeForAttachmentEntity: vi.fn(),
}));
vi.mock('@/lib/supabase-storage', () => ({
  createSignedDownloadUrl: vi.fn(),
}));
vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(async () => {}),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { authorizeForAttachmentEntity } from '@/services/attachment.service';
import { createSignedDownloadUrl } from '@/lib/supabase-storage';
import { recordError } from '@/services/error-log.service';
import { GET } from './route';

const buildReq = () => new NextRequest('http://localhost/api/attachments/abc/download');
const buildParams = () => ({ params: Promise.resolve({ id: 'abc' }) });

const mockUser = { id: 'user-1', tenantId: 'tenant-1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/api/attachments/[id]/download GET', () => {
  it('認証失敗で 401 を返す', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValueOnce(
      NextResponse.json({ error: 'unauthorized' }, { status: 401 }) as never,
    );

    const res = await GET(buildReq(), buildParams());
    expect(res.status).toBe(401);
  });

  it('attachment 不在 (= 越境試行含む) で 404 を返す', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValueOnce(mockUser as never);
    vi.mocked(prisma.attachment.findFirst).mockResolvedValueOnce(null);

    const res = await GET(buildReq(), buildParams());
    expect(res.status).toBe(404);
  });

  it('成功時に downloadFilename=displayName を渡し signed URL に 302 redirect', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValueOnce(mockUser as never);
    vi.mocked(prisma.attachment.findFirst).mockResolvedValueOnce({
      id: 'att-1',
      entityType: 'project',
      entityId: 'p-1',
      storageProvider: 'supabase',
      storageObjectKey: 'tenants/tenant-1/project/p-1/abc.pdf',
      url: 'tenants/tenant-1/project/p-1/abc.pdf',
      displayName: '機密資料.pdf',
    } as never);
    vi.mocked(authorizeForAttachmentEntity).mockResolvedValueOnce({ ok: true } as never);
    vi.mocked(createSignedDownloadUrl).mockResolvedValueOnce(
      'https://supabase.example/signed?download=true',
    );

    const res = await GET(buildReq(), buildParams());

    expect(res.status).toBe(302);
    expect(createSignedDownloadUrl).toHaveBeenCalledWith(
      'tenants/tenant-1/project/p-1/abc.pdf',
      60,
      { downloadFilename: '機密資料.pdf' },
    );
  });

  it('displayName=null の場合 downloadFilename=undefined で渡される (= download=true のみ)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValueOnce(mockUser as never);
    vi.mocked(prisma.attachment.findFirst).mockResolvedValueOnce({
      id: 'att-1',
      entityType: 'project',
      entityId: 'p-1',
      storageProvider: 'supabase',
      storageObjectKey: 'tenants/tenant-1/project/p-1/abc.pdf',
      url: 'tenants/tenant-1/project/p-1/abc.pdf',
      displayName: null,
    } as never);
    vi.mocked(authorizeForAttachmentEntity).mockResolvedValueOnce({ ok: true } as never);
    vi.mocked(createSignedDownloadUrl).mockResolvedValueOnce('https://supabase.example/signed');

    const res = await GET(buildReq(), buildParams());

    expect(res.status).toBe(302);
    expect(createSignedDownloadUrl).toHaveBeenCalledWith(
      expect.any(String),
      60,
      { downloadFilename: undefined },
    );
  });

  it('legacy url 型 (storageProvider !== supabase) は attachment.url にそのまま redirect', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValueOnce(mockUser as never);
    vi.mocked(prisma.attachment.findFirst).mockResolvedValueOnce({
      id: 'att-1',
      entityType: 'project',
      entityId: 'p-1',
      storageProvider: 'url',
      storageObjectKey: null,
      url: 'https://external.example/file.pdf',
      displayName: 'external.pdf',
    } as never);
    vi.mocked(authorizeForAttachmentEntity).mockResolvedValueOnce({ ok: true } as never);

    const res = await GET(buildReq(), buildParams());

    expect(res.status).toBe(302);
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it('signedUrl 発行失敗時は 503 と recordError を呼ぶ', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValueOnce(mockUser as never);
    vi.mocked(prisma.attachment.findFirst).mockResolvedValueOnce({
      id: 'att-1',
      entityType: 'project',
      entityId: 'p-1',
      storageProvider: 'supabase',
      storageObjectKey: 'tenants/tenant-1/project/p-1/abc.pdf',
      url: 'tenants/tenant-1/project/p-1/abc.pdf',
      displayName: 'doc.pdf',
    } as never);
    vi.mocked(authorizeForAttachmentEntity).mockResolvedValueOnce({ ok: true } as never);
    vi.mocked(createSignedDownloadUrl).mockRejectedValueOnce(new Error('sign failed'));

    const res = await GET(buildReq(), buildParams());

    expect(res.status).toBe(503);
    expect(recordError).toHaveBeenCalled();
  });
});
