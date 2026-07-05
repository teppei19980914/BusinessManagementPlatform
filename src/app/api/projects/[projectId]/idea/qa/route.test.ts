import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  checkProjectPermission: vi.fn(),
  requireActualProjectMember: vi.fn(),
}));

vi.mock('@/services/idea-qa.service', () => ({
  listQaThreads: vi.fn(),
  createQaThread: vi.fn(),
}));

vi.mock('@/services/audit.service', () => ({
  recordAuditLog: vi.fn(),
}));

import { GET, POST } from './route';
import { NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission, requireActualProjectMember } from '@/lib/api-helpers';
import { listQaThreads, createQaThread } from '@/services/idea-qa.service';

const mockedGetAuth = vi.mocked(getAuthenticatedUser);
const mockedCheckPerm = vi.mocked(checkProjectPermission);
const mockedRequireMember = vi.mocked(requireActualProjectMember);
const mockedList = vi.mocked(listQaThreads);
const mockedCreate = vi.mocked(createQaThread);

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

const THREAD_DTO = {
  id: 'th-1',
  projectId: 'p-1',
  question: 'テスト質問',
  answerCount: 0,
  lastAnsweredAt: null,
  upvoteCount: 0,
  status: 'open',
  isStale: false,
  hasUpvoted: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  answers: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetAuth.mockResolvedValue(VALID_USER);
  mockedCheckPerm.mockResolvedValue(null);
  mockedRequireMember.mockResolvedValue(null);
  mockedList.mockResolvedValue([THREAD_DTO]);
  mockedCreate.mockResolvedValue(THREAD_DTO);
});

describe('GET /idea/qa', () => {
  it('未認証なら 401', async () => {
    mockedGetAuth.mockResolvedValueOnce(
      NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }),
    );
    const res = await GET(new Request('http://localhost') as never, mockParams('p-1'));
    expect(res.status).toBe(401);
  });

  it('スレッド一覧を返す', async () => {
    const res = await GET(new Request('http://localhost') as never, mockParams('p-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });

  it('sort と filter を渡す', async () => {
    mockedList.mockResolvedValueOnce([]);
    const res = await GET(
      new Request('http://localhost?sort=upvoteCount&filter=open') as never,
      mockParams('p-1'),
    );
    expect(res.status).toBe(200);
    expect(mockedList).toHaveBeenCalledWith('p-1', VALID_USER.id, VALID_USER.tenantId, 'upvoteCount', 'open', undefined);
  });

  it('不明な sort/filter は既定値を使う', async () => {
    mockedList.mockResolvedValueOnce([]);
    await GET(
      new Request('http://localhost?sort=invalid&filter=invalid') as never,
      mockParams('p-1'),
    );
    expect(mockedList).toHaveBeenCalledWith('p-1', VALID_USER.id, VALID_USER.tenantId, 'createdAt', 'all', undefined);
  });

  it('q クエリパラメータをキーワード検索として渡す', async () => {
    mockedList.mockResolvedValueOnce([]);
    await GET(
      new Request('http://localhost?q=テスト質問') as never,
      mockParams('p-1'),
    );
    expect(mockedList).toHaveBeenCalledWith('p-1', VALID_USER.id, VALID_USER.tenantId, 'createdAt', 'all', 'テスト質問');
  });
});

describe('POST /idea/qa', () => {
  it('バリデーションエラーで 400', async () => {
    const res = await POST(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify({}) }) as never,
      mockParams('p-1'),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('スレッドを作成して 201', async () => {
    const res = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ question: 'テスト質問' }),
      }) as never,
      mockParams('p-1'),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.question).toBe('テスト質問');
  });
});
