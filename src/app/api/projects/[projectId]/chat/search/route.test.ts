import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  checkProjectPermission: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
}));

vi.mock('@/services/project-chat-search.service', () => ({
  projectChatSearch: vi.fn(),
}));

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));

import { POST } from './route';
import { NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { projectChatSearch } from '@/services/project-chat-search.service';

const mockedGetAuth = vi.mocked(getAuthenticatedUser);
const mockedCheckPerm = vi.mocked(checkProjectPermission);
const mockedSearch = vi.mocked(projectChatSearch);

const VALID_USER = {
  id: '00000000-0000-0000-0000-000000000010',
  tenantId: '00000000-0000-0000-0000-000000000001',
  name: 'Tester',
  email: 't@example.com',
  systemRole: 'general' as const,
};

const EMPTY_RESULT = {
  query: 'テスト',
  degraded: false,
  results: { knowledges: [], risksIssues: [], retrospectives: [], qaThreads: [], whiteboardSessions: [], votingSessions: [] },
  totalCount: 0,
};

function mockParams(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/projects/p-1/chat/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetAuth.mockResolvedValue(VALID_USER);
  mockedCheckPerm.mockResolvedValue(null);
  mockedSearch.mockResolvedValue(EMPTY_RESULT);
});

describe('POST /api/projects/[projectId]/chat/search', () => {
  it('未認証なら 401', async () => {
    mockedGetAuth.mockResolvedValueOnce(
      NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }),
    );
    const res = await POST(makeRequest({ query: 'test' }), mockParams('p-1'));
    expect(res.status).toBe(401);
  });

  it('権限なしなら 403', async () => {
    mockedCheckPerm.mockResolvedValueOnce(
      NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }),
    );
    const res = await POST(makeRequest({ query: 'test' }), mockParams('p-1'));
    expect(res.status).toBe(403);
  });

  it('query が文字列でない場合は 400', async () => {
    const res = await POST(makeRequest({ query: 123 }), mockParams('p-1'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
  });

  it('query が 8000 字超の場合は 400', async () => {
    const res = await POST(makeRequest({ query: 'a'.repeat(8001) }), mockParams('p-1'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('QUERY_TOO_LONG');
  });

  it('正常系: projectChatSearch を呼び出し 200 で結果を返す', async () => {
    const res = await POST(makeRequest({ query: 'リスク対策' }), mockParams('p-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ query: 'テスト', degraded: false });
    expect(mockedSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'リスク対策',
        projectId: 'p-1',
        tenantId: VALID_USER.tenantId,
        userId: VALID_USER.id,
      }),
    );
  });

  it('サービスが例外を投げたとき 500 を返す', async () => {
    mockedSearch.mockRejectedValueOnce(new Error('DB connection failed'));
    const res = await POST(makeRequest({ query: 'テスト' }), mockParams('p-1'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});
