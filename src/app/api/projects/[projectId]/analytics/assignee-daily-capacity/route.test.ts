/**
 * GET /api/projects/[projectId]/analytics/assignee-daily-capacity
 *
 * 検証観点: 認可 (401/403 透過) / { data } 返却 / テナント受け渡し / 'analytics:read' 使用。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  checkProjectPermission: vi.fn(),
}));
vi.mock('@/services/analytics.service', () => ({
  getAssigneeDailyCapacity: vi.fn(),
}));

import { GET } from './route';
import { NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { getAssigneeDailyCapacity } from '@/services/analytics.service';

const mockedGetAuthenticatedUser = vi.mocked(getAuthenticatedUser);
const mockedCheckProjectPermission = vi.mocked(checkProjectPermission);
const mockedCapacity = vi.mocked(getAssigneeDailyCapacity);

const TENANT_A = '00000000-0000-0000-0000-000000000001';

function mockParams(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}
function makeUser() {
  return { id: 'u1', tenantId: TENANT_A, name: 'A', email: 'a@example.com', systemRole: 'general' as const };
}

const SAMPLE = {
  today: '2026-06-12',
  dates: ['2026-06-12', '2026-06-13'],
  assignees: [
    {
      assigneeId: 'uX',
      assigneeName: 'X',
      cells: [
        { date: '2026-06-12', effortHours: 9, level: 'alert' as const },
        { date: '2026-06-13', effortHours: 4, level: 'ok' as const },
      ],
      alertDayCount: 1,
      warnDayCount: 1,
      maxDailyEffort: 9,
    },
  ],
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
    expect(mockedCapacity).not.toHaveBeenCalled();
  });

  it('analytics:read 不可 → 403 を透過', async () => {
    mockedGetAuthenticatedUser.mockResolvedValueOnce(makeUser());
    mockedCheckProjectPermission.mockResolvedValueOnce(
      NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }),
    );
    const res = await GET(new Request('http://localhost/x') as never, mockParams('p1'));
    expect(res.status).toBe(403);
    expect(mockedCapacity).not.toHaveBeenCalled();
  });

  it("checkProjectPermission に 'analytics:read' を渡す", async () => {
    mockedGetAuthenticatedUser.mockResolvedValueOnce(makeUser());
    mockedCheckProjectPermission.mockResolvedValueOnce(null);
    mockedCapacity.mockResolvedValueOnce(SAMPLE);
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
    mockedCapacity.mockResolvedValueOnce(SAMPLE);
    const res = await GET(new Request('http://localhost/x') as never, mockParams('p1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.dates).toEqual(['2026-06-12', '2026-06-13']);
    expect(body.data.assignees[0].cells[0].level).toBe('alert');
  });

  it('[テナント分離] projectId と viewerTenantId が渡る (range なし)', async () => {
    mockedCapacity.mockResolvedValueOnce(SAMPLE);
    await GET(new Request('http://localhost/x') as never, mockParams('p1'));
    expect(mockedCapacity).toHaveBeenCalledWith('p1', TENANT_A, undefined, undefined);
  });

  it('from/to クエリを range としてサービスへ渡す (未来キャップは to)', async () => {
    mockedCapacity.mockResolvedValueOnce(SAMPLE);
    await GET(
      new Request('http://localhost/x?from=2026-06-12&to=2026-09-12') as never,
      mockParams('p1'),
    );
    expect(mockedCapacity).toHaveBeenCalledWith('p1', TENANT_A, undefined, {
      from: '2026-06-12',
      to: '2026-09-12',
    });
  });
});
