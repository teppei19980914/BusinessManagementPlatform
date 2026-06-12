/**
 * GET /api/projects/[projectId]/analytics/assignee-throughput
 *
 * 検証観点: 認可 (401/403/404 透過) / { data } 返却 / テナント受け渡し / 'analytics:read' 使用。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  checkProjectPermission: vi.fn(),
}));
vi.mock('@/services/analytics.service', () => ({
  getAssigneeWeeklyEffort: vi.fn(),
}));

import { GET } from './route';
import { NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { getAssigneeWeeklyEffort } from '@/services/analytics.service';

const mockedGetAuthenticatedUser = vi.mocked(getAuthenticatedUser);
const mockedCheckProjectPermission = vi.mocked(checkProjectPermission);
const mockedThroughput = vi.mocked(getAssigneeWeeklyEffort);

const TENANT_A = '00000000-0000-0000-0000-000000000001';

function mockParams(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}
function makeUser() {
  return { id: 'u1', tenantId: TENANT_A, name: 'A', email: 'a@example.com', systemRole: 'general' as const };
}

const SAMPLE = {
  today: '2026-06-10',
  weekStarts: ['2026-06-01', '2026-06-08'],
  assignees: [{ assigneeId: 'uX', assigneeName: 'X', totalEffort: 12, weekly: [5, 7] }],
  completedActCount: 2,
  effortLoggedCount: 2,
  totalPlannedEffort: 10,
  totalActualEffort: 12,
  efficiency: 0.83,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('認証・認可', () => {
  it('未認証 → 401 を透過', async () => {
    mockedGetAuthenticatedUser.mockResolvedValueOnce(
      NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }),
    );
    const res = await GET(new Request('http://localhost/x') as never, mockParams('p1'));
    expect(res.status).toBe(401);
    expect(mockedThroughput).not.toHaveBeenCalled();
  });

  it('analytics:read 不可 → 403 を透過', async () => {
    mockedGetAuthenticatedUser.mockResolvedValueOnce(makeUser());
    mockedCheckProjectPermission.mockResolvedValueOnce(
      NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }),
    );
    const res = await GET(new Request('http://localhost/x') as never, mockParams('p1'));
    expect(res.status).toBe(403);
    expect(mockedThroughput).not.toHaveBeenCalled();
  });

  it("checkProjectPermission に 'analytics:read' を渡す", async () => {
    mockedGetAuthenticatedUser.mockResolvedValueOnce(makeUser());
    mockedCheckProjectPermission.mockResolvedValueOnce(null);
    mockedThroughput.mockResolvedValueOnce(SAMPLE);
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
    mockedThroughput.mockResolvedValueOnce(SAMPLE);
    const res = await GET(new Request('http://localhost/x') as never, mockParams('p1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.weekStarts).toEqual(['2026-06-01', '2026-06-08']);
    expect(body.data.assignees[0].totalEffort).toBe(12);
    expect(body.data.efficiency).toBe(0.83);
  });

  it('[テナント分離] projectId と viewerTenantId が渡る (range なし)', async () => {
    mockedThroughput.mockResolvedValueOnce(SAMPLE);
    await GET(new Request('http://localhost/x') as never, mockParams('p1'));
    expect(mockedThroughput).toHaveBeenCalledWith('p1', TENANT_A, undefined, undefined);
  });

  it('from/to クエリを range としてサービスへ渡す', async () => {
    mockedThroughput.mockResolvedValueOnce(SAMPLE);
    await GET(
      new Request('http://localhost/x?from=2026-06-01&to=2026-06-30') as never,
      mockParams('p1'),
    );
    expect(mockedThroughput).toHaveBeenCalledWith('p1', TENANT_A, undefined, {
      from: '2026-06-01',
      to: '2026-06-30',
    });
  });
});
