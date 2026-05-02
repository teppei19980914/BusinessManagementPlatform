import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  checkProjectPermission: vi.fn(),
}));
vi.mock('@/services/task.service', () => ({
  listTasksWithTree: vi.fn(),
}));

import { GET } from './route';
import { NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { listTasksWithTree } from '@/services/task.service';

const mockedGetAuthenticatedUser = vi.mocked(getAuthenticatedUser);
const mockedCheckProjectPermission = vi.mocked(checkProjectPermission);
const mockedListTasksWithTree = vi.mocked(listTasksWithTree);

function mockParams(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

describe('GET /api/projects/[projectId]/tasks/tree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('認証・認可を通過すると listTasksWithTree の結果を返す', async () => {
    mockedGetAuthenticatedUser.mockResolvedValueOnce({
      id: 'u1',
      tenantId: '00000000-0000-0000-0000-000000000001',
      name: 'A',
      email: 'a@example.com',
      systemRole: 'general',
    });
    mockedCheckProjectPermission.mockResolvedValueOnce(null);
    mockedListTasksWithTree.mockResolvedValueOnce({
      tree: [],
      flat: [],
    });

    const req = new Request('http://localhost/x');
    const res = await GET(req as unknown as never, mockParams('p1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: { tree: [], flat: [] } });
    expect(mockedListTasksWithTree).toHaveBeenCalledWith('p1');
  });

  it('未認証なら認証ヘルパーの 401 レスポンスをそのまま返す', async () => {
    const unauthorized = NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
    mockedGetAuthenticatedUser.mockResolvedValueOnce(unauthorized);

    const req = new Request('http://localhost/x');
    const res = await GET(req as unknown as never, mockParams('p1'));
    expect(res.status).toBe(401);
    expect(mockedListTasksWithTree).not.toHaveBeenCalled();
  });

  it('プロジェクト非メンバーなら権限ヘルパーの 403/404 をそのまま返す（DB には問い合わせない）', async () => {
    mockedGetAuthenticatedUser.mockResolvedValueOnce({
      id: 'u1',
      tenantId: '00000000-0000-0000-0000-000000000001',
      name: 'A',
      email: 'a@example.com',
      systemRole: 'general',
    });
    const forbidden = NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    mockedCheckProjectPermission.mockResolvedValueOnce(forbidden);

    const req = new Request('http://localhost/x');
    const res = await GET(req as unknown as never, mockParams('p1'));
    expect(res.status).toBe(404);
    expect(mockedListTasksWithTree).not.toHaveBeenCalled();
  });
});
