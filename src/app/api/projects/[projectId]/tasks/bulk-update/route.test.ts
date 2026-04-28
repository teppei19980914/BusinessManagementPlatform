/**
 * PR #85: 一括更新 API の動的権限判定テスト。
 *
 * 検証観点:
 *   - 計画系フィールド (assigneeId 等) を含めば task:update を要求する
 *   - 実績系フィールドのみなら task:update_progress で通す
 *   - member ロールかつ実績系のみの場合、自分担当以外のタスクを 1 件でも含めば 403
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/permissions', () => ({
  checkPermission: vi.fn(),
  checkMembership: vi.fn(),
}));
vi.mock('@/services/task.service', () => ({
  bulkUpdateTasks: vi.fn(),
}));
vi.mock('@/services/audit.service', () => ({
  recordBulkAuditLogs: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    projectMember: { findFirst: vi.fn() },
    task: { findMany: vi.fn() },
  },
}));

import { PATCH } from './route';
import { auth } from '@/lib/auth';
import { checkPermission, checkMembership } from '@/lib/permissions';
import { bulkUpdateTasks } from '@/services/task.service';
import { prisma } from '@/lib/db';

function makeReq(body: unknown): Request {
  return new Request('http://test/api/projects/p-1/tasks/bulk-update', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeParams() {
  return { params: Promise.resolve({ projectId: 'p-1' }) };
}

const memberUser = {
  user: {
    id: 'u-member',
    name: 'Member',
    email: 'm@x.co',
    systemRole: 'general',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue(memberUser as never);
});

describe('PATCH /bulk-update — 権限判定', () => {
  it('計画系 (plannedEndDate) を含むと task:update を要求する', async () => {
    vi.mocked(checkMembership).mockResolvedValue({
      isMember: true,
      projectRole: 'pm_tl',
      projectStatus: 'active',
    });
    vi.mocked(checkPermission).mockReturnValue({ allowed: true });
    vi.mocked(bulkUpdateTasks).mockResolvedValue(1);

    const res = await PATCH(
      makeReq({
        taskIds: ['11111111-1111-4111-8111-111111111111'],
        plannedEndDate: '2026-05-01',
      }) as never,
      makeParams() as never,
    );

    expect(res.status).toBe(200);
    expect(checkPermission).toHaveBeenCalledWith('task:update', expect.anything());
  });

  it('実績系のみ (progressRate) は task:update_progress を要求する', async () => {
    vi.mocked(checkMembership).mockResolvedValue({
      isMember: true,
      projectRole: 'member',
      projectStatus: 'active',
    });
    vi.mocked(checkPermission).mockReturnValue({ allowed: true });
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue({
      projectRole: 'member',
    } as never);
    vi.mocked(prisma.task.findMany).mockResolvedValue([]); // 自分担当以外は 0 件
    vi.mocked(bulkUpdateTasks).mockResolvedValue(1);

    const res = await PATCH(
      makeReq({
        taskIds: ['11111111-1111-4111-8111-111111111111'],
        progressRate: 50,
      }) as never,
      makeParams() as never,
    );

    expect(res.status).toBe(200);
    expect(checkPermission).toHaveBeenCalledWith(
      'task:update_progress',
      expect.anything(),
    );
  });

  it('member が他人担当のタスクを含めて進捗更新しようとすると 403', async () => {
    vi.mocked(checkMembership).mockResolvedValue({
      isMember: true,
      projectRole: 'member',
      projectStatus: 'active',
    });
    vi.mocked(checkPermission).mockReturnValue({ allowed: true });
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue({
      projectRole: 'member',
    } as never);
    // 他人担当タスクが 1 件でもあれば即 403
    vi.mocked(prisma.task.findMany).mockResolvedValue([
      { id: '22222222-2222-4222-8222-222222222222' },
    ] as never);

    const res = await PATCH(
      makeReq({
        taskIds: [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
        ],
        status: 'in_progress',
      }) as never,
      makeParams() as never,
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
    expect(bulkUpdateTasks).not.toHaveBeenCalled();
  });

  it('PR #88: admin / pm_tl も実績系一括更新では担当者チェックを受ける (他人担当を含むと 403)', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: {
        id: 'admin-1',
        name: 'Admin',
        email: 'a@x.co',
        systemRole: 'admin',
      },
    } as never);
    vi.mocked(checkMembership).mockResolvedValue({
      isMember: true,
      projectRole: 'pm_tl',
      projectStatus: 'active',
    });
    vi.mocked(checkPermission).mockReturnValue({ allowed: true });
    // 他人担当のタスクが 1 件でもあれば 403 (admin であっても)
    vi.mocked(prisma.task.findMany).mockResolvedValue([
      { id: '22222222-2222-4222-8222-222222222222' },
    ] as never);

    const res = await PATCH(
      makeReq({
        taskIds: [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
        ],
        status: 'completed',
      }) as never,
      makeParams() as never,
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    // T-17 Group 2: メッセージは i18n 経由 (vitest.setup.ts のスタブで key 名がそのまま返る)
    expect(body.error.message).toBe('bulkProgressOwnTasksOnly');
  });

  it('PR #88: admin も全対象タスクが自分担当なら実績系一括更新に成功する', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: {
        id: 'admin-1',
        name: 'Admin',
        email: 'a@x.co',
        systemRole: 'admin',
      },
    } as never);
    vi.mocked(checkMembership).mockResolvedValue({
      isMember: true,
      projectRole: 'pm_tl',
      projectStatus: 'active',
    });
    vi.mocked(checkPermission).mockReturnValue({ allowed: true });
    // 他人担当のタスクは 0 件 (全て自分担当)
    vi.mocked(prisma.task.findMany).mockResolvedValue([]);
    vi.mocked(bulkUpdateTasks).mockResolvedValue(1);

    const res = await PATCH(
      makeReq({
        taskIds: ['11111111-1111-4111-8111-111111111111'],
        status: 'completed',
      }) as never,
      makeParams() as never,
    );

    expect(res.status).toBe(200);
  });

  it('PR #88: 計画系の一括更新 (assigneeId 等) は admin / pm_tl が対象関係なく可能', async () => {
    vi.mocked(checkMembership).mockResolvedValue({
      isMember: true,
      projectRole: 'pm_tl',
      projectStatus: 'active',
    });
    vi.mocked(checkPermission).mockReturnValue({ allowed: true });
    vi.mocked(bulkUpdateTasks).mockResolvedValue(2);

    const res = await PATCH(
      makeReq({
        taskIds: [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
        ],
        // plannedEndDate は計画系なので ownership チェック適用外
        plannedEndDate: '2026-06-30',
      }) as never,
      makeParams() as never,
    );

    expect(res.status).toBe(200);
    expect(prisma.task.findMany).not.toHaveBeenCalled();
  });

  it('バリデーション失敗時は 400', async () => {
    const res = await PATCH(
      makeReq({ taskIds: [] }) as never, // 1 件以上必須
      makeParams() as never,
    );
    expect(res.status).toBe(400);
  });
});
