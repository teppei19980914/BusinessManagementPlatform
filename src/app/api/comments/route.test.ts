import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * /api/comments ルートの認可マトリクステスト (PR fix/visibility-auth-matrix)。
 *
 * 検証する 4 軸:
 *   - entityType: issue / risk / retrospective / knowledge (visibility あり) / task / customer
 *   - entity.visibility: public / draft
 *   - viewer の関係: 作成者本人 / 他人 / admin
 *   - mode: read (GET) / write (POST)
 */

vi.mock('@/lib/db', () => ({
  prisma: {
    comment: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    riskIssue: { findFirst: vi.fn() },
    retrospective: { findFirst: vi.fn() },
    knowledge: { findFirst: vi.fn() },
    task: { findFirst: vi.fn() },
    stakeholder: { findFirst: vi.fn() },
    customer: { findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/permissions', () => ({
  checkMembership: vi.fn(),
}));

vi.mock('@/services/audit.service', () => ({
  recordAuditLog: vi.fn(),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (k: string) => k),
}));

import { GET, POST } from './route';
import { prisma } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { checkMembership } from '@/lib/permissions';

const ENTITY_ID = '00000000-0000-4000-8000-000000000001';

function getReq(entityType: string, entityId: string): NextRequest {
  const url = `http://localhost/api/comments?entityType=${entityType}&entityId=${entityId}`;
  return new NextRequest(url);
}

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/comments', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.comment.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.comment.create).mockResolvedValue({
    id: 'c-1',
    entityType: 'issue',
    entityId: ENTITY_ID,
    userId: 'u-1',
    content: 'hi',
    createdAt: new Date(),
    updatedAt: new Date(),
    user: { name: 'Alice' },
  } as never);
});

describe('GET /api/comments — public-or-draft entity (issue / risk / retrospective / knowledge)', () => {
  it('issue public: 任意の認証済ユーザは read 可', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-other', systemRole: 'general' } as never);
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      visibility: 'public', reporterId: 'u-creator',
    } as never);

    const res = await GET(getReq('issue', ENTITY_ID));
    expect(res.status).toBe(200);
  });

  it('issue draft: 作成者本人は read 可', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-creator', systemRole: 'general' } as never);
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      visibility: 'draft', reporterId: 'u-creator',
    } as never);

    const res = await GET(getReq('issue', ENTITY_ID));
    expect(res.status).toBe(200);
  });

  it('issue draft: admin は read のみ可 (404/403 ではなく 200)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-admin', systemRole: 'admin' } as never);
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      visibility: 'draft', reporterId: 'u-creator',
    } as never);

    const res = await GET(getReq('issue', ENTITY_ID));
    expect(res.status).toBe(200);
  });

  it('issue draft: 他人 (非作成者・非 admin) は 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-other', systemRole: 'general' } as never);
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      visibility: 'draft', reporterId: 'u-creator',
    } as never);

    const res = await GET(getReq('issue', ENTITY_ID));
    expect(res.status).toBe(403);
  });

  it('retrospective draft: 他人は 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-other', systemRole: 'general' } as never);
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({
      visibility: 'draft', createdBy: 'u-creator',
    } as never);

    const res = await GET(getReq('retrospective', ENTITY_ID));
    expect(res.status).toBe(403);
  });

  it('knowledge public: 他人でも read 可', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-other', systemRole: 'general' } as never);
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
      visibility: 'public', createdBy: 'u-creator',
    } as never);

    const res = await GET(getReq('knowledge', ENTITY_ID));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/comments — public-or-draft entity の write 認可', () => {
  it('issue public: 他人でも write 可', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-other', systemRole: 'general' } as never);
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      visibility: 'public', reporterId: 'u-creator',
    } as never);

    const res = await POST(postReq({ entityType: 'issue', entityId: ENTITY_ID, content: 'hi' }));
    expect(res.status).toBe(201);
  });

  it('issue draft: 作成者本人のみ write 可', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-creator', systemRole: 'general' } as never);
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      visibility: 'draft', reporterId: 'u-creator',
    } as never);

    const res = await POST(postReq({ entityType: 'issue', entityId: ENTITY_ID, content: 'hi' }));
    expect(res.status).toBe(201);
  });

  it('issue draft: admin は write 不可 (read はできても投稿不可)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-admin', systemRole: 'admin' } as never);
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      visibility: 'draft', reporterId: 'u-creator',
    } as never);

    const res = await POST(postReq({ entityType: 'issue', entityId: ENTITY_ID, content: 'hi' }));
    expect(res.status).toBe(403);
  });

  it('issue draft: 他人は write 不可', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-other', systemRole: 'general' } as never);
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      visibility: 'draft', reporterId: 'u-creator',
    } as never);

    const res = await POST(postReq({ entityType: 'issue', entityId: ENTITY_ID, content: 'hi' }));
    expect(res.status).toBe(403);
  });
});

describe('GET/POST — project-scoped (task / stakeholder)', () => {
  it('task: project member は read/write 可', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-member', systemRole: 'general' } as never);
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ projectId: 'p-1' } as never);
    vi.mocked(checkMembership).mockResolvedValue({ isMember: true, projectRole: 'member', projectStatus: 'active' } as never);

    const getRes = await GET(getReq('task', ENTITY_ID));
    expect(getRes.status).toBe(200);

    const postRes = await POST(postReq({ entityType: 'task', entityId: ENTITY_ID, content: 'hi' }));
    expect(postRes.status).toBe(201);
  });

  it('task: 非 project member は 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-out', systemRole: 'general' } as never);
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ projectId: 'p-1' } as never);
    vi.mocked(checkMembership).mockResolvedValue({ isMember: false, projectRole: null, projectStatus: 'active' } as never);

    const res = await GET(getReq('task', ENTITY_ID));
    expect(res.status).toBe(403);
  });

  it('task: admin は member でなくても read/write 可', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-admin', systemRole: 'admin' } as never);
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ projectId: 'p-1' } as never);

    const res = await GET(getReq('task', ENTITY_ID));
    expect(res.status).toBe(200);
    expect(checkMembership).not.toHaveBeenCalled();
  });

  // PR feat/notification-edit-dialog (2026-05-01): stakeholder は PM/TL 限定に厳格化
  it('stakeholder: 一般 project member は 403 (PM/TL のみ許可)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-member', systemRole: 'general' } as never);
    vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue({ projectId: 'p-1' } as never);
    vi.mocked(checkMembership).mockResolvedValue({ isMember: true, projectRole: 'member', projectStatus: 'active' } as never);

    const postRes = await POST(postReq({ entityType: 'stakeholder', entityId: ENTITY_ID, content: 'hi' }));
    expect(postRes.status).toBe(403);
  });

  it('stakeholder: PM/TL は read/write 可', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-pmtl', systemRole: 'general' } as never);
    vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue({ projectId: 'p-1' } as never);
    vi.mocked(checkMembership).mockResolvedValue({ isMember: true, projectRole: 'pm_tl', projectStatus: 'active' } as never);

    const postRes = await POST(postReq({ entityType: 'stakeholder', entityId: ENTITY_ID, content: 'hi' }));
    expect(postRes.status).toBe(201);
  });

  it('stakeholder: viewer (project member) は 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-viewer', systemRole: 'general' } as never);
    vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue({ projectId: 'p-1' } as never);
    vi.mocked(checkMembership).mockResolvedValue({ isMember: true, projectRole: 'viewer', projectStatus: 'active' } as never);

    const postRes = await POST(postReq({ entityType: 'stakeholder', entityId: ENTITY_ID, content: 'hi' }));
    expect(postRes.status).toBe(403);
  });

  it('stakeholder: admin は role に関わらず read/write 可', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-admin', systemRole: 'admin' } as never);
    vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue({ projectId: 'p-1' } as never);

    const postRes = await POST(postReq({ entityType: 'stakeholder', entityId: ENTITY_ID, content: 'hi' }));
    expect(postRes.status).toBe(201);
  });
});

describe('GET/POST — admin-only (customer)', () => {
  it('customer: admin は read/write 可', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-admin', systemRole: 'admin' } as never);
    vi.mocked(prisma.customer.findFirst).mockResolvedValue({ id: 'cus-1' } as never);

    const res = await GET(getReq('customer', ENTITY_ID));
    expect(res.status).toBe(200);
  });

  it('customer: 非 admin は 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-other', systemRole: 'general' } as never);
    vi.mocked(prisma.customer.findFirst).mockResolvedValue({ id: 'cus-1' } as never);

    const res = await GET(getReq('customer', ENTITY_ID));
    expect(res.status).toBe(403);
  });
});

describe('not-found', () => {
  it('存在しない entity は 404', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-1', systemRole: 'general' } as never);
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(null);

    const res = await GET(getReq('issue', ENTITY_ID));
    expect(res.status).toBe(404);
  });
});
