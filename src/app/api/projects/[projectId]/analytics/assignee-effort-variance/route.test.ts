/**
 * GET /api/projects/[projectId]/analytics/assignee-effort-variance
 *
 * 検証観点: 認可 (401/403 透過) / { data } 返却 / テナント受け渡し / 'analytics:read' 使用。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  checkProjectPermission: vi.fn(),
}));
vi.mock('@/services/analytics.service', () => ({
  getAssigneeEffortVariance: vi.fn(),
}));

import { GET } from './route';
import { NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { getAssigneeEffortVariance } from '@/services/analytics.service';

const mockedGetAuthenticatedUser = vi.mocked(getAuthenticatedUser);
const mockedCheckProjectPermission = vi.mocked(checkProjectPermission);
const mockedVariance = vi.mocked(getAssigneeEffortVariance);

const TENANT_A = '00000000-0000-0000-0000-000000000001';

function mockParams(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}
function makeUser() {
  return { id: 'u1', tenantId: TENANT_A, name: 'A', email: 'a@example.com', systemRole: 'general' as const };
}

const SAMPLE = {
  assignees: [{ assigneeId: 'uX', assigneeName: 'X', taskCount: 2, plannedEffort: 12, actualEffort: 15 }],
  totalPlannedEffort: 12,
  totalActualEffort: 15,
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
    expect(mockedVariance).not.toHaveBeenCalled();
  });

  it('analytics:read 不可 → 403 を透過', async () => {
    mockedGetAuthenticatedUser.mockResolvedValueOnce(makeUser());
    mockedCheckProjectPermission.mockResolvedValueOnce(
      NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }),
    );
    const res = await GET(new Request('http://localhost/x') as never, mockParams('p1'));
    expect(res.status).toBe(403);
    expect(mockedVariance).not.toHaveBeenCalled();
  });

  it("checkProjectPermission に 'analytics:read' を渡す", async () => {
    mockedGetAuthenticatedUser.mockResolvedValueOnce(makeUser());
    mockedCheckProjectPermission.mockResolvedValueOnce(null);
    mockedVariance.mockResolvedValueOnce(SAMPLE);
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
    mockedVariance.mockResolvedValueOnce(SAMPLE);
    const res = await GET(new Request('http://localhost/x') as never, mockParams('p1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.assignees[0].plannedEffort).toBe(12);
    expect(body.data.assignees[0].actualEffort).toBe(15);
  });

  it('[テナント分離] projectId と viewerTenantId が渡る (range なしは undefined)', async () => {
    mockedVariance.mockResolvedValueOnce(SAMPLE);
    await GET(new Request('http://localhost/x') as never, mockParams('p1'));
    expect(mockedVariance).toHaveBeenCalledWith('p1', TENANT_A, undefined);
  });

  it('from/to クエリを range としてサービスへ渡す', async () => {
    mockedVariance.mockResolvedValueOnce(SAMPLE);
    await GET(
      new Request('http://localhost/x?from=2026-06-01&to=2026-06-30') as never,
      mockParams('p1'),
    );
    expect(mockedVariance).toHaveBeenCalledWith('p1', TENANT_A, {
      from: '2026-06-01',
      to: '2026-06-30',
    });
  });

  it('不正な日付クエリは無視して range なし (undefined)', async () => {
    mockedVariance.mockResolvedValueOnce(SAMPLE);
    await GET(new Request('http://localhost/x?from=bad&to=2026/06/30') as never, mockParams('p1'));
    expect(mockedVariance).toHaveBeenCalledWith('p1', TENANT_A, undefined);
  });
});
