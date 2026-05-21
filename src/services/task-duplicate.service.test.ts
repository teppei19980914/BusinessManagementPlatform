/**
 * task-duplicate.service.ts のテスト。
 *
 * カバー範囲:
 *   - 件数 validation (0 / 101)
 *   - テナント越境防止 (project not found)
 *   - 同 project 縛り (cross-project task)
 *   - target parent validation (not found / ACT)
 *   - WP/ACT 構造ルール (ACT を root にしない)
 *   - 階層保持 (選択範囲内の親子関係を残す)
 *   - 名称衝突自動リネーム ((コピー), (コピー 2))
 *   - 実績フィールドのリセット (status, progressRate, actualStartDate)
 *   - 計画フィールドのコピー (assignee, planned dates, effort)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: vi.fn() },
    task: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('./task.service', async () => {
  const actual = await vi.importActual<typeof import('./task.service')>('./task.service');
  return {
    ...actual,
    recalculateAncestorsPublic: vi.fn().mockResolvedValue(undefined),
  };
});

import { duplicateTasks, pickNonConflictingName } from './task-duplicate.service';
import { prisma } from '@/lib/db';
import { recalculateAncestorsPublic } from './task.service';

const projectId = 'proj-1';
const userId = 'user-1';
const tenantId = 'tenant-1';

const baseTask = {
  id: 'src-1',
  projectId,
  parentTaskId: null,
  type: 'work_package',
  wbsNumber: '1.0',
  name: '設計',
  description: null,
  category: 'other',
  assigneeId: null,
  plannedStartDate: null,
  plannedEndDate: null,
  plannedEffort: 0,
  priority: null,
  isMilestone: false,
  notes: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: projectId } as never);
  // 既定: target parent 配下に既存子なし、target parent 自身もデフォルト null (= root)
  // 各テストで個別に上書きする
  vi.mocked(prisma.task.findMany).mockImplementation(async (args: unknown) => {
    const where = (args as { where: { id?: { in: string[] }; parentTaskId?: string | null } }).where;
    if (where.id?.in) {
      // findMany for sources — 各テストで mock しなおす
      return [] as never;
    }
    // findMany for fetchChildrenNames (parentTaskId フィルタ)
    return [] as never;
  });
});

describe('duplicateTasks: validation', () => {
  it('taskIds が空 → TASKS_OUT_OF_RANGE', async () => {
    await expect(
      duplicateTasks({ projectId, taskIds: [], targetParentId: null, userId, viewerTenantId: tenantId }),
    ).rejects.toThrow('TASKS_OUT_OF_RANGE');
  });

  it('taskIds が 101 件以上 → TASKS_OUT_OF_RANGE', async () => {
    const taskIds = Array.from({ length: 101 }, (_, i) => `t-${i}`);
    await expect(
      duplicateTasks({ projectId, taskIds, targetParentId: null, userId, viewerTenantId: tenantId }),
    ).rejects.toThrow('TASKS_OUT_OF_RANGE');
  });

  it('project not found (他テナント) → PROJECT_NOT_FOUND', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null);
    await expect(
      duplicateTasks({ projectId, taskIds: ['x'], targetParentId: null, userId, viewerTenantId: 'other' }),
    ).rejects.toThrow('PROJECT_NOT_FOUND');
  });

  it('一部の taskId が DB に存在しない → TASKS_NOT_FOUND', async () => {
    vi.mocked(prisma.task.findMany).mockImplementation(async (args: unknown) => {
      const w = (args as { where: { id?: { in: string[] } } }).where;
      if (w.id?.in) return [baseTask] as never;
      return [] as never;
    });
    await expect(
      duplicateTasks({
        projectId,
        taskIds: ['src-1', 'missing'],
        targetParentId: null,
        userId,
        viewerTenantId: tenantId,
      }),
    ).rejects.toThrow('TASKS_NOT_FOUND:missing');
  });

  it('別 project の task 混入 → TASKS_CROSS_PROJECT', async () => {
    vi.mocked(prisma.task.findMany).mockImplementation(async (args: unknown) => {
      const w = (args as { where: { id?: { in: string[] } } }).where;
      if (w.id?.in) return [{ ...baseTask, projectId: 'OTHER' }] as never;
      return [] as never;
    });
    await expect(
      duplicateTasks({
        projectId,
        taskIds: ['src-1'],
        targetParentId: null,
        userId,
        viewerTenantId: tenantId,
      }),
    ).rejects.toThrow('TASKS_CROSS_PROJECT');
  });

  it('target parent が存在しない → TARGET_PARENT_NOT_FOUND', async () => {
    vi.mocked(prisma.task.findMany).mockImplementation(async (args: unknown) => {
      const w = (args as { where: { id?: { in: string[] } } }).where;
      if (w.id?.in) return [baseTask] as never;
      return [] as never;
    });
    vi.mocked(prisma.task.findFirst).mockResolvedValue(null);
    await expect(
      duplicateTasks({
        projectId,
        taskIds: ['src-1'],
        targetParentId: 'missing-target',
        userId,
        viewerTenantId: tenantId,
      }),
    ).rejects.toThrow('TARGET_PARENT_NOT_FOUND');
  });

  it('target parent が ACT → TARGET_PARENT_NOT_WP', async () => {
    vi.mocked(prisma.task.findMany).mockImplementation(async (args: unknown) => {
      const w = (args as { where: { id?: { in: string[] } } }).where;
      if (w.id?.in) return [baseTask] as never;
      return [] as never;
    });
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ id: 'act-1', type: 'activity' } as never);
    await expect(
      duplicateTasks({
        projectId,
        taskIds: ['src-1'],
        targetParentId: 'act-1',
        userId,
        viewerTenantId: tenantId,
      }),
    ).rejects.toThrow('TARGET_PARENT_NOT_WP');
  });

  it('ACT を root (target=null) に置こうとする → ACT_CANNOT_BE_ROOT', async () => {
    vi.mocked(prisma.task.findMany).mockImplementation(async (args: unknown) => {
      const w = (args as { where: { id?: { in: string[] } } }).where;
      if (w.id?.in) return [{ ...baseTask, type: 'activity', name: 'リーダー作業' }] as never;
      return [] as never;
    });
    await expect(
      duplicateTasks({
        projectId,
        taskIds: ['src-1'],
        targetParentId: null,
        userId,
        viewerTenantId: tenantId,
      }),
    ).rejects.toThrow(/ACT_CANNOT_BE_ROOT.*リーダー作業/);
  });
});

describe('duplicateTasks: 階層保持 + 実行', () => {
  it('単一 WP の複製: name はリネームなし, 実績はリセット, 計画はコピー', async () => {
    const created: Array<Record<string, unknown>> = [];
    vi.mocked(prisma.task.findMany).mockImplementation(async (args: unknown) => {
      const w = (args as { where: { id?: { in: string[] }; parentTaskId?: string | null } }).where;
      if (w.id?.in) return [baseTask] as never;
      return [] as never; // children names 空
    });
    vi.mocked(prisma.task.create).mockImplementation(async (args: unknown) => {
      const data = (args as { data: Record<string, unknown> }).data;
      const c = { ...data, id: `new-${created.length + 1}` };
      created.push(c);
      return c as never;
    });

    const r = await duplicateTasks({
      projectId,
      taskIds: ['src-1'],
      targetParentId: null,
      userId,
      viewerTenantId: tenantId,
    });
    expect(r.added).toBe(1);
    expect(r.renamedCount).toBe(0);
    expect(created[0].name).toBe('設計');
    expect(created[0].status).toBe('not_started');
    expect(created[0].progressRate).toBe(0);
    expect(created[0].actualStartDate).toBe(null);
    expect(created[0].actualEndDate).toBe(null);
  });

  it('名称衝突: 同 root 配下に同名 WP が既存 → "(コピー)" suffix で renamedCount=1', async () => {
    const created: Array<Record<string, unknown>> = [];
    vi.mocked(prisma.task.findMany).mockImplementation(async (args: unknown) => {
      const w = (args as { where: { id?: { in: string[] }; parentTaskId?: string | null } }).where;
      if (w.id?.in) return [baseTask] as never;
      // root 配下に「設計」が既存
      if (w.parentTaskId === null) return [{ name: '設計' }] as never;
      return [] as never;
    });
    vi.mocked(prisma.task.create).mockImplementation(async (args: unknown) => {
      const data = (args as { data: Record<string, unknown> }).data;
      const c = { ...data, id: `new-${created.length + 1}` };
      created.push(c);
      return c as never;
    });

    const r = await duplicateTasks({
      projectId,
      taskIds: ['src-1'],
      targetParentId: null,
      userId,
      viewerTenantId: tenantId,
    });
    expect(r.added).toBe(1);
    expect(r.renamedCount).toBe(1);
    expect(created[0].name).toBe('設計 (コピー)');
  });

  it('階層保持: WP + ACT を一括選択 → WP\' 配下に ACT\' を作る (target parent でなく内側親に follow)', async () => {
    const wp = { ...baseTask, id: 'wp-1', name: 'WP-A', type: 'work_package' };
    const act = {
      ...baseTask,
      id: 'act-1',
      name: 'ACT-X',
      type: 'activity',
      parentTaskId: 'wp-1',
    };
    const created: Array<Record<string, unknown>> = [];
    vi.mocked(prisma.task.findMany).mockImplementation(async (args: unknown) => {
      const w = (args as { where: { id?: { in: string[] }; parentTaskId?: string | null } }).where;
      if (w.id?.in) return [wp, act] as never;
      return [] as never; // root 配下空
    });
    vi.mocked(prisma.task.create).mockImplementation(async (args: unknown) => {
      const data = (args as { data: Record<string, unknown> }).data;
      const c = { ...data, id: `new-${created.length + 1}` };
      created.push(c);
      return c as never;
    });

    const r = await duplicateTasks({
      projectId,
      taskIds: ['wp-1', 'act-1'],
      targetParentId: null,
      userId,
      viewerTenantId: tenantId,
    });
    expect(r.added).toBe(2);
    // 親→子の順で作成されているはず
    expect(created[0].name).toBe('WP-A');
    expect(created[0].parentTaskId).toBe(null);
    expect(created[1].name).toBe('ACT-X');
    // ACT' の parent は WP' の新 id (new-1)
    expect(created[1].parentTaskId).toBe('new-1');
  });

  it('選択範囲外の親は target parent に follow: ACT 単体を選択 → 元の WP を無視して target parent 直下', async () => {
    const act = {
      ...baseTask,
      id: 'act-1',
      name: 'ACT-X',
      type: 'activity',
      parentTaskId: 'unselected-wp', // 選択範囲外
    };
    const created: Array<Record<string, unknown>> = [];
    vi.mocked(prisma.task.findMany).mockImplementation(async (args: unknown) => {
      const w = (args as { where: { id?: { in: string[] }; parentTaskId?: string | null } }).where;
      if (w.id?.in) return [act] as never;
      return [] as never;
    });
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ id: 'target-wp', type: 'work_package' } as never);
    vi.mocked(prisma.task.create).mockImplementation(async (args: unknown) => {
      const data = (args as { data: Record<string, unknown> }).data;
      const c = { ...data, id: `new-${created.length + 1}` };
      created.push(c);
      return c as never;
    });

    const r = await duplicateTasks({
      projectId,
      taskIds: ['act-1'],
      targetParentId: 'target-wp',
      userId,
      viewerTenantId: tenantId,
    });
    expect(r.added).toBe(1);
    expect(created[0].parentTaskId).toBe('target-wp'); // 元 unselected-wp ではなく target-wp 配下
  });

  it('[FIX] 新規作成 WP 自身の plannedEffort を集計再計算する (WP + ACT 同時複製時の漏れ防止)', async () => {
    // バグ: target parent のみ recalc していたが、新規 WP は plannedEffort=0 で作成された後に
    //   ACT 子が追加されても集計されないため、WP の planned_effort が 0 のまま残る問題があった。
    // 修正: 新規 WP 自身を affectedWpIds に含めて recalc を呼ぶ。
    const wp = { ...baseTask, id: 'wp-1', name: 'WP-A', type: 'work_package' };
    const act = {
      ...baseTask,
      id: 'act-1',
      name: 'ACT-X',
      type: 'activity',
      parentTaskId: 'wp-1',
      plannedEffort: 3,
    };
    vi.mocked(prisma.task.findMany).mockImplementation(async (args: unknown) => {
      const w = (args as { where: { id?: { in: string[] }; parentTaskId?: string | null } }).where;
      if (w.id?.in) return [wp, act] as never;
      return [] as never;
    });
    let createCount = 0;
    vi.mocked(prisma.task.create).mockImplementation(async () => {
      createCount += 1;
      return { id: `new-${createCount}` } as never;
    });

    // target parent: null (root) で複製 → target に対する recalc は呼ばれない
    const r = await duplicateTasks({
      projectId,
      taskIds: ['wp-1', 'act-1'],
      targetParentId: null,
      userId,
      viewerTenantId: tenantId,
    });
    expect(r.added).toBe(2);
    // 新規 WP (new-1) に対して recalc が呼ばれていること = この修正の本質
    expect(recalculateAncestorsPublic).toHaveBeenCalledWith('new-1');
    // 新規 ACT (new-2) は WP ではないが、現実装では affectedWpIds に含めないので呼ばれない
    expect(recalculateAncestorsPublic).not.toHaveBeenCalledWith('new-2');
  });

  it('[FIX] target parent (WP) + 新規 WP 両方が recalc される', async () => {
    const wp = { ...baseTask, id: 'wp-1', name: 'WP-A', type: 'work_package' };
    const act = {
      ...baseTask,
      id: 'act-1',
      name: 'ACT-X',
      type: 'activity',
      parentTaskId: 'wp-1',
      plannedEffort: 3,
    };
    vi.mocked(prisma.task.findMany).mockImplementation(async (args: unknown) => {
      const w = (args as { where: { id?: { in: string[] }; parentTaskId?: string | null } }).where;
      if (w.id?.in) return [wp, act] as never;
      return [] as never;
    });
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ id: 'target-wp', type: 'work_package' } as never);
    let createCount = 0;
    vi.mocked(prisma.task.create).mockImplementation(async () => {
      createCount += 1;
      return { id: `new-${createCount}` } as never;
    });

    await duplicateTasks({
      projectId,
      taskIds: ['wp-1', 'act-1'],
      targetParentId: 'target-wp',
      userId,
      viewerTenantId: tenantId,
    });
    // target-wp と新規 WP (new-1) の両方が recalc される
    expect(recalculateAncestorsPublic).toHaveBeenCalledWith('target-wp');
    expect(recalculateAncestorsPublic).toHaveBeenCalledWith('new-1');
  });

  it('同じ名前の WP を 2 件同時複製: 2 件目は "(コピー)" でリネーム', async () => {
    // WP-A と WP-A (同名) を 2 つ並んだ状態で同時複製。target 配下に既存なし、しかし
    // 選択された 2 件の WP は同名なので、2 件目だけリネーム
    const wp1 = { ...baseTask, id: 'wp-1', name: 'WP-A' };
    const wp2 = { ...baseTask, id: 'wp-2', name: 'WP-A' };
    const created: Array<Record<string, unknown>> = [];
    vi.mocked(prisma.task.findMany).mockImplementation(async (args: unknown) => {
      const w = (args as { where: { id?: { in: string[] }; parentTaskId?: string | null } }).where;
      if (w.id?.in) return [wp1, wp2] as never;
      return [] as never;
    });
    vi.mocked(prisma.task.create).mockImplementation(async (args: unknown) => {
      const data = (args as { data: Record<string, unknown> }).data;
      const c = { ...data, id: `new-${created.length + 1}` };
      created.push(c);
      return c as never;
    });

    const r = await duplicateTasks({
      projectId,
      taskIds: ['wp-1', 'wp-2'],
      targetParentId: null,
      userId,
      viewerTenantId: tenantId,
    });
    expect(r.added).toBe(2);
    expect(r.renamedCount).toBe(1);
    expect(created[0].name).toBe('WP-A');
    expect(created[1].name).toBe('WP-A (コピー)');
  });
});

describe('pickNonConflictingName', () => {
  it('未衝突なら元の名前', () => {
    expect(pickNonConflictingName('Foo', new Set())).toBe('Foo');
  });

  it('1 件衝突 → "(コピー)" 付き', () => {
    expect(pickNonConflictingName('Foo', new Set(['Foo']))).toBe('Foo (コピー)');
  });

  it('2 件衝突 → "(コピー 2)" 付き', () => {
    expect(pickNonConflictingName('Foo', new Set(['Foo', 'Foo (コピー)']))).toBe('Foo (コピー 2)');
  });

  it('3 件衝突 → "(コピー 3)" 付き', () => {
    expect(
      pickNonConflictingName('Foo', new Set(['Foo', 'Foo (コピー)', 'Foo (コピー 2)'])),
    ).toBe('Foo (コピー 3)');
  });
});
