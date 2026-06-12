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
    // 2026-06-12: コメント投稿のクローズ済みPJガード (isCommentTargetFullyClosed) が参照する
    //   多対多ジャンクション。既定は空配列 = 「紐付く全PJが closed」ではない (= ブロックしない)。
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
  // 2026-06-12: クローズ済みPJガードの多対多クエリは既定で空 (= ブロックしない)。
  //   個別テストで「全PJ closed」を検証する場合のみ closed な project を返すよう上書きする。
  vi.mocked(prisma.knowledgeProject.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.riskIssueProject.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.retrospectiveProject.findMany).mockResolvedValue([] as never);
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

  // 2026-06-12: クローズ済みPJ (= 読み取り専用) の資産にはコメント投稿不可。
  it('knowledge public: 紐付く全PJが closed なら write 不可 (403 PROJECT_CLOSED)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-creator', systemRole: 'general' } as never);
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
      visibility: 'public', createdBy: 'u-creator',
    } as never);
    // 紐付く全プロジェクトが closed
    vi.mocked(prisma.knowledgeProject.findMany).mockResolvedValue([
      { project: { status: 'closed' } },
    ] as never);

    const res = await POST(postReq({ entityType: 'knowledge', entityId: ENTITY_ID, content: 'hi' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('PROJECT_CLOSED');
  });

  it('knowledge public: closed と open の両PJに紐付くなら write 可 (稼働中PJで生きている)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-creator', systemRole: 'general' } as never);
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
      visibility: 'public', createdBy: 'u-creator',
    } as never);
    vi.mocked(prisma.knowledgeProject.findMany).mockResolvedValue([
      { project: { status: 'closed' } },
      { project: { status: 'active' } },
    ] as never);

    const res = await POST(postReq({ entityType: 'knowledge', entityId: ENTITY_ID, content: 'hi' }));
    expect(res.status).toBe(201);
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

  // PR feat/notification-deep-link-completion (2026-05-01): task コメント認可緩和。
  //   plain コメント / read: 認証済ユーザ全員可 (PMO や他チームレビュアーが残せる)
  //   mention 含む write: ProjectMember (or admin) 必須 (mention 受信者を project 内に限定)
  it('task: 非 project member でも plain コメント (read/write) は可能', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-out', systemRole: 'general' } as never);
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ projectId: 'p-1' } as never);

    const getRes = await GET(getReq('task', ENTITY_ID));
    expect(getRes.status).toBe(200);

    const postRes = await POST(postReq({ entityType: 'task', entityId: ENTITY_ID, content: 'hi' }));
    expect(postRes.status).toBe(201);
  });

  it('task: 非 project member の mention 含む write は 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-out', systemRole: 'general' } as never);
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ projectId: 'p-1' } as never);
    vi.mocked(checkMembership).mockResolvedValue({ isMember: false, projectRole: null, projectStatus: 'active' } as never);

    const res = await POST(postReq({
      entityType: 'task',
      entityId: ENTITY_ID,
      content: 'hi',
      mentions: [{ kind: 'all' }],
    }));
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
