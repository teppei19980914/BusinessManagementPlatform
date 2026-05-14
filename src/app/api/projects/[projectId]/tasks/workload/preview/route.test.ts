/**
 * GET /api/projects/[projectId]/tasks/workload/preview (PR #361 / 2026-05-14)
 *
 * 検証観点:
 *   1. 認証・認可 (未認証 → 401、非メンバー → 404)
 *   2. query パラメータ検証 (zod)
 *   3. service 結果の返却
 *   4. テナント分離: previewActivityWorkload に viewerTenantId が確実に渡る
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  checkProjectPermission: vi.fn(),
}));
vi.mock('@/services/task.service', () => ({
  previewActivityWorkload: vi.fn(),
}));

import { GET } from './route';
import { NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { previewActivityWorkload } from '@/services/task.service';

const mockedGetAuthenticatedUser = vi.mocked(getAuthenticatedUser);
const mockedCheckProjectPermission = vi.mocked(checkProjectPermission);
const mockedPreview = vi.mocked(previewActivityWorkload);

const TENANT_A = '00000000-0000-0000-0000-000000000001';
// zod の UUID 検証は variant ビット (= 13桁目が 8/9/a/b、19桁目が 8/9/a/b) を要求するため、
// テスト用 ID も valid UUID v4 を使用 (デフォルトの '22222222-...' は variant 不正で reject される)。
const ASSIGNEE = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '11111111-1111-4111-8111-111111111112';

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('認証・認可', () => {
  it('未認証 → 401 を透過', async () => {
    const unauth = NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
    mockedGetAuthenticatedUser.mockResolvedValueOnce(unauth);
    const req = new Request(
      `http://localhost/x?assigneeId=${ASSIGNEE}&startDate=2026-06-15&endDate=2026-06-15&plannedEffort=4`,
    );
    const res = await GET(req as never, mockParams('p1'));
    expect(res.status).toBe(401);
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it('非メンバー → 404 を透過 (checkProjectPermission の結果)', async () => {
    mockedGetAuthenticatedUser.mockResolvedValueOnce(makeUser());
    const forbidden = NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    mockedCheckProjectPermission.mockResolvedValueOnce(forbidden);
    const req = new Request(
      `http://localhost/x?assigneeId=${ASSIGNEE}&startDate=2026-06-15&endDate=2026-06-15&plannedEffort=4`,
    );
    const res = await GET(req as never, mockParams('p1'));
    expect(res.status).toBe(404);
    expect(mockedPreview).not.toHaveBeenCalled();
  });
});

describe('query パラメータ検証', () => {
  beforeEach(() => {
    mockedGetAuthenticatedUser.mockResolvedValueOnce(makeUser());
    mockedCheckProjectPermission.mockResolvedValueOnce(null);
  });

  it('assigneeId が不正な UUID → 400', async () => {
    const req = new Request(
      `http://localhost/x?assigneeId=NOT_UUID&startDate=2026-06-15&endDate=2026-06-15&plannedEffort=4`,
    );
    const res = await GET(req as never, mockParams('p1'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('startDate が YYYY-MM-DD 以外 → 400', async () => {
    const req = new Request(
      `http://localhost/x?assigneeId=${ASSIGNEE}&startDate=06/15/2026&endDate=2026-06-15&plannedEffort=4`,
    );
    const res = await GET(req as never, mockParams('p1'));
    expect(res.status).toBe(400);
  });

  it('plannedEffort が負値 → 400', async () => {
    const req = new Request(
      `http://localhost/x?assigneeId=${ASSIGNEE}&startDate=2026-06-15&endDate=2026-06-15&plannedEffort=-1`,
    );
    const res = await GET(req as never, mockParams('p1'));
    expect(res.status).toBe(400);
  });
});

describe('正常系', () => {
  beforeEach(() => {
    mockedGetAuthenticatedUser.mockResolvedValueOnce(makeUser());
    mockedCheckProjectPermission.mockResolvedValueOnce(null);
  });

  it('service 結果を { data } で返却', async () => {
    mockedPreview.mockResolvedValueOnce({
      maxDailyEffort: 5.5,
      maxDailyDate: '2026-06-15',
      level: 'ok',
    });
    const req = new Request(
      `http://localhost/x?assigneeId=${ASSIGNEE}&startDate=2026-06-15&endDate=2026-06-16&plannedEffort=11`,
    );
    const res = await GET(req as never, mockParams('p1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.maxDailyEffort).toBe(5.5);
    expect(body.data.level).toBe('ok');
  });

  // ★ テナント分離 (severity-1)
  it('[テナント分離] previewActivityWorkload に viewerTenantId が確実に渡る', async () => {
    mockedPreview.mockResolvedValueOnce({
      maxDailyEffort: 0,
      maxDailyDate: null,
      level: 'ok',
    });
    const req = new Request(
      `http://localhost/x?assigneeId=${ASSIGNEE}&startDate=2026-06-15&endDate=2026-06-15&plannedEffort=4`,
    );
    await GET(req as never, mockParams('p1'));
    expect(mockedPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        viewerTenantId: TENANT_A,
        projectId: 'p1',
        assigneeId: ASSIGNEE,
      }),
    );
  });

  it('excludeTaskId 付き → service に渡る', async () => {
    mockedPreview.mockResolvedValueOnce({
      maxDailyEffort: 0,
      maxDailyDate: null,
      level: 'ok',
    });
    const req = new Request(
      `http://localhost/x?assigneeId=${ASSIGNEE}&startDate=2026-06-15&endDate=2026-06-15&plannedEffort=4&excludeTaskId=${TASK_ID}`,
    );
    await GET(req as never, mockParams('p1'));
    expect(mockedPreview).toHaveBeenCalledWith(
      expect.objectContaining({ excludeTaskId: TASK_ID }),
    );
  });
});
