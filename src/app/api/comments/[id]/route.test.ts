import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * /api/comments/[id] PATCH/DELETE の認可テスト (PR fix/visibility-auth-matrix)。
 *
 * 仕様: **投稿者本人のみ** (admin 不可)。
 */

vi.mock('@/lib/db', () => ({
  prisma: {
    comment: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/services/audit.service', () => ({
  recordAuditLog: vi.fn(),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (k: string) => k),
}));

import { PATCH, DELETE } from './route';
import { prisma } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/api-helpers';

const COMMENT_ID = 'c-1';

function patchReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/comments/c-1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function deleteReq(): NextRequest {
  return new NextRequest('http://localhost/api/comments/c-1', { method: 'DELETE' });
}

const params = Promise.resolve({ id: COMMENT_ID });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.comment.update).mockResolvedValue({
    id: COMMENT_ID,
    entityType: 'issue',
    entityId: 'r-1',
    userId: 'u-author',
    content: 'edited',
    createdAt: new Date(),
    updatedAt: new Date(),
    user: { name: 'Alice' },
  } as never);
});

describe('PATCH /api/comments/[id]', () => {
  it('投稿者本人は編集可', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-author', systemRole: 'general' } as never);
    vi.mocked(prisma.comment.findFirst).mockResolvedValue({
      id: COMMENT_ID, userId: 'u-author', entityType: 'issue', entityId: 'r-1',
      content: 'orig', createdAt: new Date(), updatedAt: new Date(),
      user: { name: 'Alice' },
    } as never);

    const res = await PATCH(patchReq({ content: 'edited' }), { params });
    expect(res.status).toBe(200);
  });

  it('admin は他人のコメントを編集不可 (2026-05-01 仕様変更で admin 救済を外した)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-admin', systemRole: 'admin' } as never);
    vi.mocked(prisma.comment.findFirst).mockResolvedValue({
      id: COMMENT_ID, userId: 'u-author', entityType: 'issue', entityId: 'r-1',
      content: 'orig', createdAt: new Date(), updatedAt: new Date(),
      user: { name: 'Alice' },
    } as never);

    const res = await PATCH(patchReq({ content: 'admin-edit' }), { params });
    expect(res.status).toBe(403);
  });

  it('他人 (非投稿者) は 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-other', systemRole: 'general' } as never);
    vi.mocked(prisma.comment.findFirst).mockResolvedValue({
      id: COMMENT_ID, userId: 'u-author', entityType: 'issue', entityId: 'r-1',
      content: 'orig', createdAt: new Date(), updatedAt: new Date(),
      user: { name: 'Alice' },
    } as never);

    const res = await PATCH(patchReq({ content: 'hijack' }), { params });
    expect(res.status).toBe(403);
  });

  it('存在しないコメントは 404', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-author', systemRole: 'general' } as never);
    vi.mocked(prisma.comment.findFirst).mockResolvedValue(null);

    const res = await PATCH(patchReq({ content: 'x' }), { params });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/comments/[id]', () => {
  it('投稿者本人は削除可', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-author', systemRole: 'general' } as never);
    vi.mocked(prisma.comment.findFirst).mockResolvedValue({
      id: COMMENT_ID, userId: 'u-author', entityType: 'issue', entityId: 'r-1',
      content: 'orig', createdAt: new Date(), updatedAt: new Date(),
      user: { name: 'Alice' },
    } as never);

    const res = await DELETE(deleteReq(), { params });
    expect(res.status).toBe(200);
  });

  it('admin は他人のコメントを削除不可', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-admin', systemRole: 'admin' } as never);
    vi.mocked(prisma.comment.findFirst).mockResolvedValue({
      id: COMMENT_ID, userId: 'u-author', entityType: 'issue', entityId: 'r-1',
      content: 'orig', createdAt: new Date(), updatedAt: new Date(),
      user: { name: 'Alice' },
    } as never);

    const res = await DELETE(deleteReq(), { params });
    expect(res.status).toBe(403);
  });

  it('他人 (非投稿者) は 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-other', systemRole: 'general' } as never);
    vi.mocked(prisma.comment.findFirst).mockResolvedValue({
      id: COMMENT_ID, userId: 'u-author', entityType: 'issue', entityId: 'r-1',
      content: 'orig', createdAt: new Date(), updatedAt: new Date(),
      user: { name: 'Alice' },
    } as never);

    const res = await DELETE(deleteReq(), { params });
    expect(res.status).toBe(403);
  });
});
