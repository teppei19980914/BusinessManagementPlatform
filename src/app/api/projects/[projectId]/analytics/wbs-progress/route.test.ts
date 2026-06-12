/**
 * GET /api/projects/[projectId]/analytics/wbs-progress
 *
 * 検証観点:
 *   1. 認証・認可 (未認証 → 401、analytics:read 不可 → 403/404 を透過)
 *   2. service 結果の返却 ({ data })
 *   3. テナント分離: getWbsCompletionCurve に viewerTenantId が確実に渡る
 *   4. checkProjectPermission に 'analytics:read' を渡している
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  checkProjectPermission: vi.fn(),
}));
vi.mock('@/services/analytics.service', () => ({
  getWbsCompletionCurve: vi.fn(),
}));

import { GET } from './route';
import { NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { getWbsCompletionCurve } from '@/services/analytics.service';

const mockedGetAuthenticatedUser = vi.mocked(getAuthenticatedUser);
const mockedCheckProjectPermission = vi.mocked(checkProjectPermission);
const mockedCurve = vi.mocked(getWbsCompletionCurve);

const TENANT_A = '00000000-0000-0000-0000-000000000001';

function mockParams(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

function makeUser() {
  return {
    id: 'u1',
    tenantId: TENANT_A,
    name: 'A',
    email: 'a@example.com',
    systemRole: 'general' as const,
  };
}

const SAMPLE = {
  totalActCount: 2,
  completedActCount: 1,
  today: '2026-06-10',
  plannedPctToday: 50,
  actualPctToday: 50,
  gapPctToday: 0,
  points: [
    { date: '2026-06-10', plannedCount: 1, plannedPct: 50, actualCount: 1, actualPct: 50 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('認証・認可', () => {
  it('未認証 → 401 を透過', async () => {
    const unauth = NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
    mockedGetAuthenticatedUser.mockResolvedValueOnce(unauth);
    const res = await GET(new Request('http://localhost/x') as never, mockParams('p1'));
    expect(res.status).toBe(401);
    expect(mockedCurve).not.toHaveBeenCalled();
  });

  it('analytics:read 不可 (member/viewer) → 403 を透過', async () => {
    mockedGetAuthenticatedUser.mockResolvedValueOnce(makeUser());
    const forbidden = NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
    mockedCheckProjectPermission.mockResolvedValueOnce(forbidden);
    const res = await GET(new Request('http://localhost/x') as never, mockParams('p1'));
    expect(res.status).toBe(403);
    expect(mockedCurve).not.toHaveBeenCalled();
  });

  it('非メンバー → 404 を透過', async () => {
    mockedGetAuthenticatedUser.mockResolvedValueOnce(makeUser());
    const notFound = NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    mockedCheckProjectPermission.mockResolvedValueOnce(notFound);
    const res = await GET(new Request('http://localhost/x') as never, mockParams('p1'));
    expect(res.status).toBe(404);
    expect(mockedCurve).not.toHaveBeenCalled();
  });

  it("checkProjectPermission に 'analytics:read' を渡す", async () => {
    mockedGetAuthenticatedUser.mockResolvedValueOnce(makeUser());
    mockedCheckProjectPermission.mockResolvedValueOnce(null);
    mockedCurve.mockResolvedValueOnce(SAMPLE);
    await GET(new Request('http://localhost/x') as never, mockParams('p1'));
    expect(mockedCheckProjectPermission).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_A }),
      'p1',
      'analytics:read',
    );
  });
});

describe('正常系', () => {
  beforeEach(() => {
    mockedGetAuthenticatedUser.mockResolvedValueOnce(makeUser());
    mockedCheckProjectPermission.mockResolvedValueOnce(null);
  });

  it('service 結果を { data } で返却', async () => {
    mockedCurve.mockResolvedValueOnce(SAMPLE);
    const res = await GET(new Request('http://localhost/x') as never, mockParams('p1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totalActCount).toBe(2);
    expect(body.data.plannedPctToday).toBe(50);
    expect(body.data.points).toHaveLength(1);
  });

  it('[テナント分離] getWbsCompletionCurve に projectId と viewerTenantId が渡る (range なし)', async () => {
    mockedCurve.mockResolvedValueOnce(SAMPLE);
    await GET(new Request('http://localhost/x') as never, mockParams('p1'));
    expect(mockedCurve).toHaveBeenCalledWith('p1', TENANT_A, undefined, undefined);
  });

  it('from/to クエリを range としてサービスへ渡す', async () => {
    mockedCurve.mockResolvedValueOnce(SAMPLE);
    await GET(
      new Request('http://localhost/x?from=2026-06-01&to=2026-06-30') as never,
      mockParams('p1'),
    );
    expect(mockedCurve).toHaveBeenCalledWith('p1', TENANT_A, undefined, {
      from: '2026-06-01',
      to: '2026-06-30',
    });
  });
});
