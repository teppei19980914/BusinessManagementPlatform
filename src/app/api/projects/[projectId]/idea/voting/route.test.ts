import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  checkProjectPermission: vi.fn(),
  requireActualProjectMember: vi.fn(),
  requireStorageQuotaForWrite: vi.fn(),
}));

vi.mock('@/services/idea-voting.service', () => ({
  listVotingSessions: vi.fn(),
  createVotingSession: vi.fn(),
}));

vi.mock('@/services/audit.service', () => ({
  recordAuditLog: vi.fn(),
}));

import { GET, POST } from './route';
import { NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission, requireActualProjectMember } from '@/lib/api-helpers';
import { listVotingSessions, createVotingSession } from '@/services/idea-voting.service';

const mockedGetAuth = vi.mocked(getAuthenticatedUser);
const mockedCheckPerm = vi.mocked(checkProjectPermission);
const mockedRequireMember = vi.mocked(requireActualProjectMember);
const mockedList = vi.mocked(listVotingSessions);
const mockedCreate = vi.mocked(createVotingSession);

const VALID_USER = {
  id: '00000000-0000-0000-0000-000000000010',
  tenantId: '00000000-0000-0000-0000-000000000001',
  name: 'Tester',
  email: 't@example.com',
  systemRole: 'general' as const,
};

function mockParams(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

const SESSION_DTO = {
  id: 's-1',
  projectId: 'p-1',
  kind: 'live',
  voteType: 'binary',
  title: 'テスト投票',
  description: null,
  votesPerMember: null,
  status: 'active',
  endsAt: FUTURE,
  closedAt: null,
  createdBy: VALID_USER.id,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  options: [],
  submissions: [],
  totalRespondents: 0,
  hasSubmitted: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetAuth.mockResolvedValue(VALID_USER);
  mockedCheckPerm.mockResolvedValue(null);
  mockedRequireMember.mockResolvedValue(null);
  mockedList.mockResolvedValue([SESSION_DTO]);
  mockedCreate.mockResolvedValue(SESSION_DTO);
});

// ============================================================
// GET
// ============================================================
describe('GET /idea/voting', () => {
  it('未認証なら 401 を透過', async () => {
    mockedGetAuth.mockResolvedValueOnce(
      NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }),
    );
    const res = await GET(new Request('http://localhost') as never, mockParams('p-1'));
    expect(res.status).toBe(401);
  });

  it('権限なしなら 403 を透過', async () => {
    mockedCheckPerm.mockResolvedValueOnce(
      NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }),
    );
    const res = await GET(new Request('http://localhost') as never, mockParams('p-1'));
    expect(res.status).toBe(403);
  });

  it('セッション一覧を返す', async () => {
    const res = await GET(new Request('http://localhost') as never, mockParams('p-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });

  it('kind クエリパラメータを渡す', async () => {
    mockedList.mockResolvedValueOnce([]);
    const res = await GET(
      new Request('http://localhost?kind=pre') as never,
      mockParams('p-1'),
    );
    expect(res.status).toBe(200);
    expect(mockedList).toHaveBeenCalledWith('p-1', VALID_USER.id, VALID_USER.tenantId, 'pre', undefined, undefined);
  });

  it('status クエリパラメータを渡す', async () => {
    mockedList.mockResolvedValueOnce([]);
    await GET(
      new Request('http://localhost?status=closed') as never,
      mockParams('p-1'),
    );
    expect(mockedList).toHaveBeenCalledWith('p-1', VALID_USER.id, VALID_USER.tenantId, undefined, 'closed', undefined);
  });

  it('不明な status は undefined を渡す', async () => {
    mockedList.mockResolvedValueOnce([]);
    await GET(
      new Request('http://localhost?status=unknown') as never,
      mockParams('p-1'),
    );
    expect(mockedList).toHaveBeenCalledWith('p-1', VALID_USER.id, VALID_USER.tenantId, undefined, undefined, undefined);
  });

  it('q クエリパラメータをキーワード検索として渡す', async () => {
    mockedList.mockResolvedValueOnce([]);
    await GET(
      new Request('http://localhost?q=テスト') as never,
      mockParams('p-1'),
    );
    expect(mockedList).toHaveBeenCalledWith('p-1', VALID_USER.id, VALID_USER.tenantId, undefined, undefined, 'テスト');
  });
});

// ============================================================
// POST
// ============================================================
describe('POST /idea/voting', () => {
  const VALID_BODY = {
    kind: 'live',
    voteType: 'binary',
    title: 'テスト投票',
    endsAt: FUTURE,
    options: [
      { label: '賛成', displayOrder: 0 },
      { label: '反対', displayOrder: 1 },
    ],
  };

  it('未認証なら 401', async () => {
    mockedGetAuth.mockResolvedValueOnce(
      NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }),
    );
    const res = await POST(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify(VALID_BODY) }) as never,
      mockParams('p-1'),
    );
    expect(res.status).toBe(401);
  });

  it('バリデーションエラーなら 400', async () => {
    const res = await POST(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify({ kind: 'live' }) }) as never,
      mockParams('p-1'),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('セッションを作成して 201 を返す', async () => {
    const res = await POST(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify(VALID_BODY) }) as never,
      mockParams('p-1'),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.title).toBe('テスト投票');
  });

  it('INVALID_ENDS_AT なら 400', async () => {
    mockedCreate.mockRejectedValueOnce(new Error('INVALID_ENDS_AT'));
    const res = await POST(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify(VALID_BODY) }) as never,
      mockParams('p-1'),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_ENDS_AT');
  });
});
