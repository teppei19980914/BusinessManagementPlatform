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
      // 2026-05-09 feedback Phase 2-5: deleteComment は越境遮断のため updateMany 経由
      updateMany: vi.fn(),
    },
    // 2026-06-12: isCommentTargetFullyClosed (クローズ済みPJガード) が参照する経路。既定は空 (= ブロックしない)。
    task: { findFirst: vi.fn() },
    stakeholder: { findFirst: vi.fn() },
    knowledgeProject: { findMany: vi.fn() },
    riskIssueProject: { findMany: vi.fn() },
    retrospectiveProject: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  // PR-5 (2026-05-15): storage quota pre-check は本テストでは常時 OK で stub
  requireStorageQuotaForWrite: vi.fn(async () => null),
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
  // 2026-06-12: クローズ済みPJガードの多対多クエリは既定で空 (= ブロックしない)。
  vi.mocked(prisma.knowledgeProject.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.riskIssueProject.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.retrospectiveProject.findMany).mockResolvedValue([] as never);
  // 2026-05-09 feedback Phase 2-5: deleteComment は updateMany 経由で実装される
  vi.mocked(prisma.comment.updateMany).mockResolvedValue({ count: 1 } as never);
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
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-author', systemRole: 'general', tenantId: 'tenant-A' } as never);
    vi.mocked(prisma.comment.findFirst).mockResolvedValue({
      id: COMMENT_ID, userId: 'u-author', entityType: 'issue', entityId: 'r-1',
      content: 'orig', createdAt: new Date(), updatedAt: new Date(),
      user: { name: 'Alice' },
    } as never);

    const res = await PATCH(patchReq({ content: 'edited' }), { params });
    expect(res.status).toBe(200);
  });

  it('admin は他人のコメントを編集不可 (2026-05-01 仕様変更で admin 救済を外した)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-admin', systemRole: 'admin', tenantId: 'tenant-A' } as never);
    vi.mocked(prisma.comment.findFirst).mockResolvedValue({
      id: COMMENT_ID, userId: 'u-author', entityType: 'issue', entityId: 'r-1',
      content: 'orig', createdAt: new Date(), updatedAt: new Date(),
      user: { name: 'Alice' },
    } as never);

    const res = await PATCH(patchReq({ content: 'admin-edit' }), { params });
    expect(res.status).toBe(403);
  });

  it('他人 (非投稿者) は 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-other', systemRole: 'general', tenantId: 'tenant-A' } as never);
    vi.mocked(prisma.comment.findFirst).mockResolvedValue({
      id: COMMENT_ID, userId: 'u-author', entityType: 'issue', entityId: 'r-1',
      content: 'orig', createdAt: new Date(), updatedAt: new Date(),
      user: { name: 'Alice' },
    } as never);

    const res = await PATCH(patchReq({ content: 'hijack' }), { params });
    expect(res.status).toBe(403);
  });

  it('存在しないコメントは 404', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-author', systemRole: 'general', tenantId: 'tenant-A' } as never);
    vi.mocked(prisma.comment.findFirst).mockResolvedValue(null);

    const res = await PATCH(patchReq({ content: 'x' }), { params });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/comments/[id]', () => {
  it('投稿者本人は削除可', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-author', systemRole: 'general', tenantId: 'tenant-A' } as never);
    vi.mocked(prisma.comment.findFirst).mockResolvedValue({
      id: COMMENT_ID, userId: 'u-author', entityType: 'issue', entityId: 'r-1',
      content: 'orig', createdAt: new Date(), updatedAt: new Date(),
      user: { name: 'Alice' },
    } as never);

    const res = await DELETE(deleteReq(), { params });
    expect(res.status).toBe(200);
  });

  it('admin は他人のコメントを削除不可', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-admin', systemRole: 'admin', tenantId: 'tenant-A' } as never);
    vi.mocked(prisma.comment.findFirst).mockResolvedValue({
      id: COMMENT_ID, userId: 'u-author', entityType: 'issue', entityId: 'r-1',
      content: 'orig', createdAt: new Date(), updatedAt: new Date(),
      user: { name: 'Alice' },
    } as never);

    const res = await DELETE(deleteReq(), { params });
    expect(res.status).toBe(403);
  });

  it('他人 (非投稿者) は 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-other', systemRole: 'general', tenantId: 'tenant-A' } as never);
    vi.mocked(prisma.comment.findFirst).mockResolvedValue({
      id: COMMENT_ID, userId: 'u-author', entityType: 'issue', entityId: 'r-1',
      content: 'orig', createdAt: new Date(), updatedAt: new Date(),
      user: { name: 'Alice' },
    } as never);

    const res = await DELETE(deleteReq(), { params });
    expect(res.status).toBe(403);
  });
});

// 2026-06-12: クローズ済みPJ (読み取り専用) の資産に紐付くコメントは、投稿者本人でも編集/削除不可。
describe('クローズ済みプロジェクトのコメント編集/削除ガード', () => {
  it('PATCH: 紐付く全PJが closed なら投稿者本人でも 403 PROJECT_CLOSED', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-author', systemRole: 'general', tenantId: 'tenant-A' } as never);
    vi.mocked(prisma.comment.findFirst).mockResolvedValue({
      id: COMMENT_ID, userId: 'u-author', entityType: 'issue', entityId: 'r-1',
      content: 'orig', createdAt: new Date(), updatedAt: new Date(), user: { name: 'Alice' },
    } as never);
    // issue → riskIssueProject、全 closed
    vi.mocked(prisma.riskIssueProject.findMany).mockResolvedValue([{ project: { status: 'closed' } }] as never);

    const res = await PATCH(patchReq({ content: 'edited' }), { params });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('PROJECT_CLOSED');
  });

  it('DELETE: 紐付く全PJが closed なら投稿者本人でも 403 PROJECT_CLOSED', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-author', systemRole: 'general', tenantId: 'tenant-A' } as never);
    vi.mocked(prisma.comment.findFirst).mockResolvedValue({
      id: COMMENT_ID, userId: 'u-author', entityType: 'issue', entityId: 'r-1',
      content: 'orig', createdAt: new Date(), updatedAt: new Date(), user: { name: 'Alice' },
    } as never);
    vi.mocked(prisma.riskIssueProject.findMany).mockResolvedValue([{ project: { status: 'closed' } }] as never);

    const res = await DELETE(deleteReq(), { params });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('PROJECT_CLOSED');
  });
});
