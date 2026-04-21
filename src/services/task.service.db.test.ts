/**
 * task.service.ts の DB インタラクション関数のテスト。
 * 既存 task.service.test.ts は Pure な集計/ツリー構築関数のみを扱うため、
 * こちらで CRUD / list 系のカバレッジを担保する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    task: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    project: { findMany: vi.fn() },
    taskProgressLog: { create: vi.fn(), findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/task-tree-utils', () => ({
  // userIds は使わずツリーをそのまま返す (listMyTaskProjects はフィルタ後を期待)
  filterTreeByAssignee: vi.fn((tree: unknown[]) => tree),
}));

import {
  listMyTaskProjects,
  listTasks,
  listTasksFlat,
  listTasksWithTree,
  getTask,
  createTask,
  deleteTask,
  getProgressLogs,
  exportWbsTemplate,
  updateTask,
  updateTaskProgress,
  bulkUpdateTasks,
} from './task.service';
import { prisma } from '@/lib/db';

const now = new Date('2026-04-21T10:00:00Z');
const rowTask = (o: Record<string, unknown> = {}) => ({
  id: 't-1',
  projectId: 'p-1',
  parentTaskId: null,
  type: 'activity',
  wbsNumber: '1.1',
  name: 'Task',
  description: null,
  category: 'other',
  assigneeId: 'u-1',
  assignee: { name: 'Alice' },
  parentTask: null,
  plannedStartDate: new Date('2026-04-01'),
  plannedEndDate: new Date('2026-04-10'),
  actualStartDate: null,
  actualEndDate: null,
  plannedEffort: 8 as unknown,
  priority: 'medium',
  status: 'not_started',
  progressRate: 0,
  isMilestone: false,
  notes: null,
  createdAt: now,
  updatedAt: now,
  ...o,
});

describe('listTasks / listTasksFlat / listTasksWithTree / getTask', () => {
  beforeEach(() => vi.clearAllMocks());

  it('listTasks: findMany + buildTree で階層を返す', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([
      rowTask({ id: 'wp', type: 'work_package', parentTaskId: null }),
      rowTask({ id: 'a1', parentTaskId: 'wp' }),
    ] as never);

    const r = await listTasks('p-1');
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('wp');
    expect(r[0].children).toHaveLength(1);
    expect(r[0].children![0].id).toBe('a1');
  });

  it('listTasksFlat: 平坦配列を返す', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([
      rowTask({ id: 'a' }),
      rowTask({ id: 'b' }),
    ] as never);

    const r = await listTasksFlat('p-1');
    expect(r).toHaveLength(2);
    expect(r[0].children).toBeUndefined();
  });

  it('listTasksWithTree: tree と flat 両方を 1 クエリで返す', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([
      rowTask({ id: 'wp', type: 'work_package' }),
      rowTask({ id: 'a', parentTaskId: 'wp' }),
    ] as never);

    const r = await listTasksWithTree('p-1');
    expect(r.tree).toHaveLength(1);
    expect(r.flat).toHaveLength(2);
    expect(prisma.task.findMany).toHaveBeenCalledOnce();
  });

  it('getTask: 存在しなければ null', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue(null);
    expect(await getTask('x')).toBe(null);
  });

  it('getTask: 存在すれば DTO', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue(rowTask() as never);
    const r = await getTask('t-1');
    expect(r?.id).toBe('t-1');
  });
});

describe('listMyTaskProjects', () => {
  beforeEach(() => vi.clearAllMocks());

  it('担当割り当てがなければ空配列', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValueOnce([]);

    const r = await listMyTaskProjects('u-1');
    expect(r).toEqual([]);
  });

  it('複数プロジェクトをまとめて返す (重複除去)', async () => {
    vi.mocked(prisma.task.findMany)
      .mockResolvedValueOnce([
        { projectId: 'p-1' } as never,
        { projectId: 'p-1' } as never,
        { projectId: 'p-2' } as never,
      ]);
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      { id: 'p-1', name: 'PJ1' } as never,
      { id: 'p-2', name: 'PJ2' } as never,
    ]);
    // listTasks 呼び出し x 2
    vi.mocked(prisma.task.findMany).mockResolvedValue([
      rowTask({ id: 't-1' }),
    ] as never);

    const r = await listMyTaskProjects('u-1');

    expect(r).toHaveLength(2);
    expect(r.map((x) => x.projectId).sort()).toEqual(['p-1', 'p-2']);
  });
});

describe('createTask', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ACT 作成: 計画値・担当が data に反映される', async () => {
    vi.mocked(prisma.task.create).mockResolvedValue(rowTask() as never);

    await createTask(
      'p-1',
      {
        type: 'activity',
        parentTaskId: null,
        wbsNumber: '1.1',
        name: 'Task',
        description: null,
        assigneeId: 'u-1',
        plannedStartDate: '2026-04-01',
        plannedEndDate: '2026-04-10',
        plannedEffort: 8,
        priority: 'medium',
        isMilestone: false,
        notes: null,
      } as never,
      'u-1',
    );

    const call = vi.mocked(prisma.task.create).mock.calls[0][0];
    expect(call.data.type).toBe('activity');
    expect(call.data.assigneeId).toBe('u-1');
    expect(call.data.plannedStartDate).toBeInstanceOf(Date);
  });

  it('WP 作成: 計画値・担当は null/0 で初期化', async () => {
    vi.mocked(prisma.task.create).mockResolvedValue(
      rowTask({ type: 'work_package', assigneeId: null }) as never,
    );

    await createTask(
      'p-1',
      {
        type: 'work_package',
        parentTaskId: null,
        wbsNumber: '1',
        name: 'WP',
        description: null,
        assigneeId: null,
        plannedStartDate: '2026-04-01',
        plannedEndDate: '2026-04-10',
        plannedEffort: 10,
        priority: 'medium',
        isMilestone: false,
        notes: null,
      } as never,
      'u-1',
    );

    const call = vi.mocked(prisma.task.create).mock.calls[0][0];
    expect(call.data.type).toBe('work_package');
    expect(call.data.assigneeId).toBe(null);
    expect(call.data.plannedStartDate).toBe(null);
    expect(call.data.plannedEffort).toBe(0);
    expect(call.data.priority).toBe(null);
  });
});

describe('deleteTask', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletedAt をセット (論理削除)', async () => {
    vi.mocked(prisma.task.findUnique).mockResolvedValue({
      parentTaskId: null,
    } as never);
    vi.mocked(prisma.task.update).mockResolvedValue({} as never);

    await deleteTask('t-1', 'u-1');

    expect(prisma.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 't-1' },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });
});

describe('getProgressLogs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('taskId で findMany + DTO に変換', async () => {
    vi.mocked(prisma.taskProgressLog.findMany).mockResolvedValue([
      {
        id: 'pl-1',
        taskId: 't-1',
        updatedBy: 'u-1',
        updateDate: now,
        progressRate: 30,
        actualEffort: 3 as unknown,
        remainingEffort: 5 as unknown,
        status: 'in_progress',
        isDelayed: false,
        delayReason: null,
        workMemo: null,
        hasIssue: false,
        nextAction: null,
        completedDate: null,
        updater: { name: 'Alice' },
        createdAt: now,
      },
    ] as never);

    const r = await getProgressLogs('t-1');

    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('pl-1');
    expect(r[0].progressRate).toBe(30);
    expect(r[0].updaterName).toBe('Alice');
    expect(prisma.taskProgressLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { taskId: 't-1' } }),
    );
  });
});

describe('exportWbsTemplate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('空プロジェクトはヘッダー行のみ', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([]);

    const csv = await exportWbsTemplate('p-1');
    expect(csv).toContain('レベル');
    expect(csv.split('\n')).toHaveLength(1); // ヘッダーのみ
  });

  it('階層構造を深さ優先で出力 + CSV ヘッダー + 種別表示 (WP / ACT)', async () => {
    const wp = {
      id: 'wp-1',
      projectId: 'p-1',
      parentTaskId: null,
      type: 'work_package',
      name: 'WP 1',
      wbsNumber: '1',
      plannedStartDate: new Date('2026-04-01'),
      plannedEndDate: null,
      plannedEffort: 0,
      priority: null,
      isMilestone: false,
      notes: null,
      createdAt: now,
      childTasks: [],
    };
    const act = {
      ...wp,
      id: 'act-1',
      parentTaskId: 'wp-1',
      type: 'activity',
      name: 'ACT 1',
      plannedEffort: 8,
      priority: 'medium',
      isMilestone: false,
    };
    vi.mocked(prisma.task.findMany).mockResolvedValue([wp, act] as never);

    const csv = await exportWbsTemplate('p-1');

    const lines = csv.split('\n');
    expect(lines[0]).toContain('レベル');
    expect(lines[1]).toContain('WP');
    expect(lines[2]).toContain('ACT');
    // 親 WP はレベル 1, 子 ACT はレベル 2
    expect(lines[1].startsWith('1,')).toBe(true);
    expect(lines[2].startsWith('2,')).toBe(true);
  });

  it('taskIds 指定時は where.id.in に反映', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([]);
    await exportWbsTemplate('p-1', ['t-a', 't-b']);

    const call = vi.mocked(prisma.task.findMany).mock.calls[0][0];
    expect(call.where.id).toEqual({ in: ['t-a', 't-b'] });
  });
});

describe('updateTask (主要分岐)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('単純フィールド更新 (status / progress 非指定) は現行値を取らずに update', async () => {
    vi.mocked(prisma.task.update).mockResolvedValue(rowTask() as never);
    vi.mocked(prisma.task.findUnique).mockResolvedValue({
      parentTaskId: null,
    } as never);

    await updateTask('t-1', { name: 'renamed' } as never, 'u-1');

    const call = vi.mocked(prisma.task.update).mock.calls[0][0];
    expect(call.data.name).toBe('renamed');
  });

  it('status=completed 指定時は progress=100 に正規化される (PR #69 整合性)', async () => {
    vi.mocked(prisma.task.findUnique).mockResolvedValue({
      status: 'in_progress',
      progressRate: 50,
      actualStartDate: new Date('2026-04-01'),
      actualEndDate: null,
      parentTaskId: null,
    } as never);
    vi.mocked(prisma.task.update).mockResolvedValue(rowTask() as never);

    await updateTask('t-1', { status: 'completed' } as never, 'u-1');

    const updateCall = vi.mocked(prisma.task.update).mock.calls[0][0];
    expect(updateCall.data.progressRate).toBe(100);
    expect(updateCall.data.status).toBe('completed');
  });

  it('progress=100 指定時は status=completed に正規化される (PR #69 整合性)', async () => {
    vi.mocked(prisma.task.findUnique).mockResolvedValue({
      status: 'in_progress',
      progressRate: 50,
      actualStartDate: new Date('2026-04-01'),
      actualEndDate: null,
      parentTaskId: null,
    } as never);
    vi.mocked(prisma.task.update).mockResolvedValue(rowTask() as never);

    await updateTask('t-1', { progressRate: 100 } as never, 'u-1');

    const updateCall = vi.mocked(prisma.task.update).mock.calls[0][0];
    expect(updateCall.data.status).toBe('completed');
    expect(updateCall.data.progressRate).toBe(100);
  });

  it('status=not_started に変えると actual 日付が両方 null になる', async () => {
    vi.mocked(prisma.task.findUnique).mockResolvedValue({
      status: 'in_progress',
      progressRate: 30,
      actualStartDate: new Date('2026-04-01'),
      actualEndDate: null,
      parentTaskId: null,
    } as never);
    vi.mocked(prisma.task.update).mockResolvedValue(rowTask() as never);

    await updateTask('t-1', { status: 'not_started' } as never, 'u-1');

    const updateCall = vi.mocked(prisma.task.update).mock.calls[0][0];
    expect(updateCall.data.actualStartDate).toBe(null);
    expect(updateCall.data.actualEndDate).toBe(null);
  });

  it('status=on_hold に変えると actualEndDate のみ null、actualStartDate は維持', async () => {
    vi.mocked(prisma.task.findUnique).mockResolvedValue({
      status: 'completed',
      progressRate: 100,
      actualStartDate: new Date('2026-04-01'),
      actualEndDate: new Date('2026-04-10'),
      parentTaskId: null,
    } as never);
    vi.mocked(prisma.task.update).mockResolvedValue(rowTask() as never);

    await updateTask('t-1', { status: 'on_hold' } as never, 'u-1');

    const updateCall = vi.mocked(prisma.task.update).mock.calls[0][0];
    expect(updateCall.data.actualStartDate).toEqual(new Date('2026-04-01'));
    expect(updateCall.data.actualEndDate).toBe(null);
  });

  it('現在タスクが見つからなければ NOT_FOUND', async () => {
    vi.mocked(prisma.task.findUnique).mockResolvedValue(null);

    await expect(
      updateTask('x', { status: 'completed' } as never, 'u-1'),
    ).rejects.toThrow('NOT_FOUND');
  });
});

describe('updateTaskProgress', () => {
  beforeEach(() => vi.clearAllMocks());

  it('進捗ログ追加 + 本体更新、progress=100 で status=completed に強制', async () => {
    vi.mocked(prisma.taskProgressLog.create).mockResolvedValue({} as never);
    vi.mocked(prisma.task.findUnique).mockResolvedValue({
      actualStartDate: null,
      actualEndDate: null,
    } as never);
    vi.mocked(prisma.task.update).mockResolvedValue({
      parentTaskId: null,
    } as never);

    await updateTaskProgress(
      't-1',
      {
        progressRate: 100,
        status: 'in_progress',
        actualEffort: 10,
        remainingEffort: 0,
        isDelayed: false,
        hasIssue: false,
      } as never,
      'u-1',
    );

    const updateCall = vi.mocked(prisma.task.update).mock.calls[0][0];
    expect(updateCall.data.status).toBe('completed');
    expect(updateCall.data.progressRate).toBe(100);
  });

  it('progress=50 / status=in_progress → そのまま保存', async () => {
    vi.mocked(prisma.taskProgressLog.create).mockResolvedValue({} as never);
    vi.mocked(prisma.task.findUnique).mockResolvedValue({
      actualStartDate: new Date('2026-04-01'),
      actualEndDate: null,
    } as never);
    vi.mocked(prisma.task.update).mockResolvedValue({
      parentTaskId: null,
    } as never);

    await updateTaskProgress(
      't-1',
      {
        progressRate: 50,
        status: 'in_progress',
        actualEffort: 5,
        remainingEffort: 5,
        isDelayed: false,
        hasIssue: false,
      } as never,
      'u-1',
    );

    const updateCall = vi.mocked(prisma.task.update).mock.calls[0][0];
    expect(updateCall.data.progressRate).toBe(50);
    expect(updateCall.data.status).toBe('in_progress');
  });
});

describe('bulkUpdateTasks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('空 taskIds は 0 を返す (no-op)', async () => {
    vi.mocked(prisma.task.updateMany).mockResolvedValue({ count: 0 } as never);

    const r = await bulkUpdateTasks('p-1', [], { status: 'in_progress' } as never, 'u-1');

    expect(r).toBe(0);
  });

  it('updateMany で ACT のみ対象に更新', async () => {
    vi.mocked(prisma.task.updateMany).mockResolvedValue({ count: 3 } as never);
    vi.mocked(prisma.task.findMany).mockResolvedValue([]);

    const r = await bulkUpdateTasks(
      'p-1',
      ['t-1', 't-2', 't-3'],
      { priority: 'high' } as never,
      'u-1',
    );

    expect(r).toBe(3);
    const call = vi.mocked(prisma.task.updateMany).mock.calls[0][0];
    expect(call.where.type).toBe('activity');
    expect(call.where.projectId).toBe('p-1');
  });
});
