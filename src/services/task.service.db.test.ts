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
      // 2026-05-25 (PR #420 #C3): createTask / updateTask の name uniqueness 事前チェック用
      count: vi.fn().mockResolvedValue(0),
    },
    // 2026-05-09 feedback Phase 2: createTask / bulkUpdateTasks の冒頭で project tenant 検証するため findFirst も mock
    project: { findMany: vi.fn(), findFirst: vi.fn() },
    taskProgressLog: { create: vi.fn(), findMany: vi.fn() },
    user: { findMany: vi.fn() },
    // PR #89: deleteTask が attachment.updateMany を $transaction 内で呼ぶ
    attachment: { updateMany: vi.fn() },
    // PR fix/visibility-auth-matrix: deleteTask も comment cascade
    comment: { updateMany: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
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
  exportWbs,
  updateTask,
  updateTaskProgress,
  bulkUpdateTasks,
} from './task.service';
import { prisma } from '@/lib/db';
import { getMockCallArg } from '@/lib/test-mock-helpers';

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

    const r = await listTasks('p-1', 'tenant-A');
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

    const r = await listTasksFlat('p-1', 'tenant-A');
    expect(r).toHaveLength(2);
    expect(r[0].children).toBeUndefined();
  });

  it('listTasksWithTree: tree と flat 両方を 1 クエリで返す', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([
      rowTask({ id: 'wp', type: 'work_package' }),
      rowTask({ id: 'a', parentTaskId: 'wp' }),
    ] as never);

    const r = await listTasksWithTree('p-1', 'tenant-A');
    expect(r.tree).toHaveLength(1);
    expect(r.flat).toHaveLength(2);
    expect(prisma.task.findMany).toHaveBeenCalledOnce();
  });

  it('getTask: 存在しなければ null', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue(null);
    expect(await getTask('x', 'tenant-A')).toBe(null);
  });

  it('getTask: 存在すれば DTO', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue(rowTask() as never);
    const r = await getTask('t-1', 'tenant-A');
    expect(r?.id).toBe('t-1');
  });
});

describe('listMyTaskProjects', () => {
  beforeEach(() => vi.clearAllMocks());

  it('担当割り当てがなければ空配列', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValueOnce([]);

    const r = await listMyTaskProjects('u-1', 'tenant-A');
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

    const r = await listMyTaskProjects('u-1', 'tenant-A');

    expect(r).toHaveLength(2);
    expect(r.map((x) => x.projectId).sort()).toEqual(['p-1', 'p-2']);
  });
});

describe('createTask', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ACT 作成: 計画値・担当が data に反映される', async () => {
    // 2026-05-09 feedback Phase 2: createTask 冒頭の project tenant 検証用 mock
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'p-1' } as never);
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
      'tenant-A',
    );

    const call = getMockCallArg(vi.mocked(prisma.task.create));
    expect(call.data.type).toBe('activity');
    expect(call.data.assigneeId).toBe('u-1');
    expect(call.data.plannedStartDate).toBeInstanceOf(Date);
  });

  it('WP 作成: 計画値・担当は null/0 で初期化', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'p-1' } as never);
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
      'tenant-A',
    );

    const call = getMockCallArg(vi.mocked(prisma.task.create));
    expect(call.data.type).toBe('work_package');
    expect(call.data.assigneeId).toBe(null);
    expect(call.data.plannedStartDate).toBe(null);
    expect(call.data.plannedEffort).toBe(0);
    expect(call.data.priority).toBe(null);
  });

  it('[FIX] 同一親配下に同名タスクが既存 → TASK_NAME_DUPLICATE_IN_PARENT を throw', async () => {
    // 2026-05-25 (PR #420 #C3): DB UNIQUE 制約適用後、createTask が DB error 500 にならず
    //   app 層で 400 相当のエラーを投げる挙動を検証
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'p-1' } as never);
    // 名称衝突あり (count=1)。**Once 版**で次テストに leak しないよう注意。
    vi.mocked(prisma.task.count).mockResolvedValueOnce(1 as never);

    await expect(
      createTask(
        'p-1',
        {
          type: 'work_package',
          name: '設計',
          parentTaskId: null,
        } as unknown as Parameters<typeof createTask>[1],
        'u-1',
        't-1',
      ),
    ).rejects.toThrow('TASK_NAME_DUPLICATE_IN_PARENT');
    // create は呼ばれていない (事前に弾かれている)
    expect(prisma.task.create).not.toHaveBeenCalled();
  });
});

describe('deleteTask', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletedAt をセット (論理削除)', async () => {
    // 2026-05-09 feedback Phase 2: deleteTask 冒頭の所有確認用 mock
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ id: 't-1' } as never);
    vi.mocked(prisma.task.findUnique).mockResolvedValue({
      parentTaskId: null,
    } as never);
    vi.mocked(prisma.task.update).mockResolvedValue({} as never);

    await deleteTask('t-1', 'u-1', 'tenant-A');

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

    const r = await getProgressLogs('t-1', 'tenant-A');

    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('pl-1');
    expect(r[0].progressRate).toBe(30);
    expect(r[0].updaterName).toBe('Alice');
    expect(prisma.taskProgressLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { taskId: 't-1' } }),
    );
  });
});

describe('exportWbs (T-19, 7 列)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('空プロジェクトは BOM + ヘッダー行のみ', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([]);

    const csv = await exportWbs('p-1', 'tenant-A');
    // BOM 付き UTF-8 + 7 列ヘッダー
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('ID,種別,名称,レベル,予定開始日,予定終了日,予定工数');
    expect(csv.split('\n')).toHaveLength(1); // ヘッダーのみ
  });

  it('階層構造を深さ優先で 7 列出力する (T-19: ID/種別/名称/レベル/開始/終了/工数)', async () => {
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

    const csv = await exportWbs('p-1', 'tenant-A');

    const lines = csv.split('\n');
    // ヘッダー (BOM 含む)
    expect(lines[0]).toContain('ID,種別,名称,レベル');
    // 1 行目: WP, level=1
    expect(lines[1]).toContain('wp-1,WP,WP 1,1,');
    // 2 行目: ACT, level=2
    expect(lines[2]).toContain('act-1,ACT,ACT 1,2,');
    // 各行 7 カラムある (= カンマ 6 個)
    expect(lines[1].split(',').length).toBe(7);
    expect(lines[2].split(',').length).toBe(7);
  });

  it('taskIds 指定時は where.id.in に反映', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([]);
    await exportWbs('p-1', 'tenant-A', ['t-a', 't-b']);

    const call = getMockCallArg(vi.mocked(prisma.task.findMany));
    expect(call?.where?.id).toEqual({ in: ['t-a', 't-b'] });
  });
});

describe('updateTask (主要分岐)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('単純フィールド更新 (status / progress 非指定) は現行値を取らずに update', async () => {
    // 2026-05-09 feedback Phase 2: updateTask 冒頭の所有確認用 mock
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ id: 't-1' } as never);
    vi.mocked(prisma.task.update).mockResolvedValue(rowTask() as never);
    vi.mocked(prisma.task.findUnique).mockResolvedValue({
      parentTaskId: null,
    } as never);

    await updateTask('t-1', { name: 'renamed' } as never, 'u-1', 'tenant-A');

    const call = getMockCallArg(vi.mocked(prisma.task.update));
    expect(call.data.name).toBe('renamed');
  });

  it('status=completed 指定時は progress=100 に正規化される (PR #69 整合性)', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ id: 't-1' } as never);
    vi.mocked(prisma.task.findUnique).mockResolvedValue({
      status: 'in_progress',
      progressRate: 50,
      actualStartDate: new Date('2026-04-01'),
      actualEndDate: null,
      parentTaskId: null,
    } as never);
    vi.mocked(prisma.task.update).mockResolvedValue(rowTask() as never);

    await updateTask('t-1', { status: 'completed' } as never, 'u-1', 'tenant-A');

    const updateCall = getMockCallArg(vi.mocked(prisma.task.update));
    expect(updateCall.data.progressRate).toBe(100);
    expect(updateCall.data.status).toBe('completed');
  });

  it('progress=100 指定時は status=completed に正規化される (PR #69 整合性)', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ id: 't-1' } as never);
    vi.mocked(prisma.task.findUnique).mockResolvedValue({
      status: 'in_progress',
      progressRate: 50,
      actualStartDate: new Date('2026-04-01'),
      actualEndDate: null,
      parentTaskId: null,
    } as never);
    vi.mocked(prisma.task.update).mockResolvedValue(rowTask() as never);

    await updateTask('t-1', { progressRate: 100 } as never, 'u-1', 'tenant-A');

    const updateCall = getMockCallArg(vi.mocked(prisma.task.update));
    expect(updateCall.data.status).toBe('completed');
    expect(updateCall.data.progressRate).toBe(100);
  });

  it('status=not_started に変えると actual 日付が両方 null になる', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ id: 't-1' } as never);
    vi.mocked(prisma.task.findUnique).mockResolvedValue({
      status: 'in_progress',
      progressRate: 30,
      actualStartDate: new Date('2026-04-01'),
      actualEndDate: null,
      parentTaskId: null,
    } as never);
    vi.mocked(prisma.task.update).mockResolvedValue(rowTask() as never);

    await updateTask('t-1', { status: 'not_started' } as never, 'u-1', 'tenant-A');

    const updateCall = getMockCallArg(vi.mocked(prisma.task.update));
    expect(updateCall.data.actualStartDate).toBe(null);
    expect(updateCall.data.actualEndDate).toBe(null);
  });

  it('[FIX] name 変更で同一親配下に同名が既存 → TASK_NAME_DUPLICATE_IN_PARENT を throw', async () => {
    // 2026-05-25 (PR #420 #C3): UNIQUE 制約適用後の DB error 500 を防ぐ事前チェック
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ id: 't-1' } as never);
    vi.mocked(prisma.task.findUnique).mockResolvedValue({
      projectId: 'p-1',
      parentTaskId: null,
      name: '元の名前',
    } as never);
    // 衝突あり (count=1)。**Once 版**で次テストに leak しないよう注意。
    vi.mocked(prisma.task.count).mockResolvedValueOnce(1 as never);

    await expect(
      updateTask('t-1', { name: '既存名' } as never, 'u-1', 'tenant-A'),
    ).rejects.toThrow('TASK_NAME_DUPLICATE_IN_PARENT');
    // update は呼ばれない
    expect(prisma.task.update).not.toHaveBeenCalled();
  });

  it('[FIX] name を「現在の名前と同じ」に編集すると uniqueness check はスキップされる (自身は除外)', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ id: 't-1' } as never);
    vi.mocked(prisma.task.findUnique).mockResolvedValue({
      projectId: 'p-1',
      parentTaskId: null,
      name: '元の名前',
    } as never);
    // 衝突があっても自身を除外しているので count 0 のはずだが、敢えて 0 を返す
    vi.mocked(prisma.task.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.task.update).mockResolvedValue(rowTask() as never);

    // 名前そのまま (= 何も変わらない) で update
    await updateTask('t-1', { name: '元の名前' } as never, 'u-1', 'tenant-A');

    // count は呼ばれない (isSamePosition で skip)
    expect(prisma.task.count).not.toHaveBeenCalled();
    // update は呼ばれる
    expect(prisma.task.update).toHaveBeenCalled();
  });

  it('status=on_hold に変えると actualEndDate のみ null、actualStartDate は維持', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ id: 't-1' } as never);
    vi.mocked(prisma.task.findUnique).mockResolvedValue({
      status: 'completed',
      progressRate: 100,
      actualStartDate: new Date('2026-04-01'),
      actualEndDate: new Date('2026-04-10'),
      parentTaskId: null,
    } as never);
    vi.mocked(prisma.task.update).mockResolvedValue(rowTask() as never);

    await updateTask('t-1', { status: 'on_hold' } as never, 'u-1', 'tenant-A');

    const updateCall = getMockCallArg(vi.mocked(prisma.task.update));
    expect(updateCall.data.actualStartDate).toEqual(new Date('2026-04-01'));
    expect(updateCall.data.actualEndDate).toBe(null);
  });

  it('現在タスクが見つからなければ NOT_FOUND', async () => {
    // 2026-05-09 feedback Phase 2: 越境/不存在いずれの場合も findFirst で NOT_FOUND を返す
    vi.mocked(prisma.task.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.task.findUnique).mockResolvedValue(null);

    await expect(
      updateTask('x', { status: 'completed' } as never, 'u-1', 'tenant-A'),
    ).rejects.toThrow('NOT_FOUND');
  });

  it('テナント越境時は NOT_FOUND (Phase 2 severity-1 防御)', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue(null); // 他テナント所有のため NOT_FOUND
    await expect(
      updateTask('t-1', { name: 'x' } as never, 'u-1', 'tenant-A'),
    ).rejects.toThrow('NOT_FOUND');
    // findFirst の where に project: { tenantId } が入っていることを検証
    const call = getMockCallArg(vi.mocked(prisma.task.findFirst));
    expect((call.where as unknown as { project: { tenantId: string } }).project.tenantId).toBe('tenant-A');
  });
});

describe('updateTaskProgress', () => {
  beforeEach(() => vi.clearAllMocks());

  it('進捗ログ追加 + 本体更新、progress=100 で status=completed に強制', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ id: 't-1' } as never);
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
      'tenant-A',
    );

    const updateCall = getMockCallArg(vi.mocked(prisma.task.update));
    expect(updateCall.data.status).toBe('completed');
    expect(updateCall.data.progressRate).toBe(100);
  });

  it('progress=50 / status=in_progress → そのまま保存', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ id: 't-1' } as never);
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
      'tenant-A',
    );

    const updateCall = getMockCallArg(vi.mocked(prisma.task.update));
    expect(updateCall.data.progressRate).toBe(50);
    expect(updateCall.data.status).toBe('in_progress');
  });
});

describe('bulkUpdateTasks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('空 taskIds は 0 を返す (no-op)', async () => {
    // 2026-05-09 feedback Phase 2: bulkUpdateTasks 冒頭の project tenant 検証用 mock
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'p-1' } as never);
    vi.mocked(prisma.task.updateMany).mockResolvedValue({ count: 0 } as never);

    const r = await bulkUpdateTasks('p-1', [], { status: 'in_progress' } as never, 'u-1', 'tenant-A');

    expect(r).toBe(0);
  });

  it('updateMany で ACT のみ対象に更新', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'p-1' } as never);
    vi.mocked(prisma.task.updateMany).mockResolvedValue({ count: 3 } as never);
    vi.mocked(prisma.task.findMany).mockResolvedValue([]);

    const r = await bulkUpdateTasks(
      'p-1',
      ['t-1', 't-2', 't-3'],
      { priority: 'high' } as never,
      'u-1',
      'tenant-A',
    );

    expect(r).toBe(3);
    const call = getMockCallArg(vi.mocked(prisma.task.updateMany));
    expect(call.where.type).toBe('activity');
    expect(call.where.projectId).toBe('p-1');
  });
});

// ================================================================
// 2026-05-09 (PR H / #7): getAssigneeDailyWorkload
// ================================================================

describe('getAssigneeDailyWorkload (PR H / #7)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('対象なしなら空配列', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValueOnce([]);
    const { getAssigneeDailyWorkload } = await import('./task.service');
    const r = await getAssigneeDailyWorkload('p-1', 'tenant-A');
    expect(r).toEqual([]);
  });

  it('plannedEffort を期間で均等按分する (1 タスク 8h × 4 日 = 1 日 2h)', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValueOnce([
      {
        assigneeId: 'u-1',
        assignee: { name: 'Alice' },
        plannedStartDate: new Date('2026-04-01T00:00:00Z'),
        plannedEndDate: new Date('2026-04-04T00:00:00Z'), // 4 日 (1,2,3,4 inclusive)
        plannedEffort: 8 as unknown,
      },
    ] as never);

    const { getAssigneeDailyWorkload } = await import('./task.service');
    const r = await getAssigneeDailyWorkload('p-1', 'tenant-A');

    expect(r).toHaveLength(1);
    expect(r[0]?.assigneeId).toBe('u-1');
    expect(r[0]?.assigneeName).toBe('Alice');
    expect(r[0]?.totalEffortHours).toBe(8);
    expect(r[0]?.taskCount).toBe(1);
    expect(r[0]?.daily).toEqual([
      { date: '2026-04-01', effortHours: 2 },
      { date: '2026-04-02', effortHours: 2 },
      { date: '2026-04-03', effortHours: 2 },
      { date: '2026-04-04', effortHours: 2 },
    ]);
  });

  it('複数 assignee + 期間重複時は同 date で加算 (担当者 = 異なる行で集計)', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValueOnce([
      {
        assigneeId: 'u-1',
        assignee: { name: 'Alice' },
        plannedStartDate: new Date('2026-04-01T00:00:00Z'),
        plannedEndDate: new Date('2026-04-02T00:00:00Z'),
        plannedEffort: 4 as unknown, // 1 日 2h
      },
      {
        assigneeId: 'u-1',
        assignee: { name: 'Alice' },
        plannedStartDate: new Date('2026-04-02T00:00:00Z'),
        plannedEndDate: new Date('2026-04-02T00:00:00Z'),
        plannedEffort: 3 as unknown, // 4/2 のみ 3h
      },
      {
        assigneeId: 'u-2',
        assignee: { name: 'Bob' },
        plannedStartDate: new Date('2026-04-01T00:00:00Z'),
        plannedEndDate: new Date('2026-04-01T00:00:00Z'),
        plannedEffort: 5 as unknown,
      },
    ] as never);

    const { getAssigneeDailyWorkload } = await import('./task.service');
    const r = await getAssigneeDailyWorkload('p-1', 'tenant-A');

    expect(r).toHaveLength(2);
    // 並び順は totalEffortHours 降順 (Alice 7h > Bob 5h)
    expect(r[0]?.assigneeName).toBe('Alice');
    expect(r[0]?.totalEffortHours).toBe(7);
    expect(r[0]?.daily).toEqual([
      { date: '2026-04-01', effortHours: 2 },
      { date: '2026-04-02', effortHours: 5 }, // 2 (按分) + 3 (1 日タスク)
    ]);
    expect(r[1]?.assigneeName).toBe('Bob');
    expect(r[1]?.totalEffortHours).toBe(5);
  });

  it('plannedEffort=0 や start>end は無視', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValueOnce([
      {
        assigneeId: 'u-1',
        assignee: { name: 'A' },
        plannedStartDate: new Date('2026-04-01T00:00:00Z'),
        plannedEndDate: new Date('2026-04-02T00:00:00Z'),
        plannedEffort: 0 as unknown,
      },
      {
        assigneeId: 'u-1',
        assignee: { name: 'A' },
        plannedStartDate: new Date('2026-04-10T00:00:00Z'),
        plannedEndDate: new Date('2026-04-01T00:00:00Z'), // start > end
        plannedEffort: 5 as unknown,
      },
    ] as never);

    const { getAssigneeDailyWorkload } = await import('./task.service');
    const r = await getAssigneeDailyWorkload('p-1', 'tenant-A');
    expect(r).toEqual([]);
  });

  it('where 句で activity 限定 + assigneeId/期日が not null', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValueOnce([]);
    const { getAssigneeDailyWorkload } = await import('./task.service');
    await getAssigneeDailyWorkload('p-1', 'tenant-A');

    const callArg = vi.mocked(prisma.task.findMany).mock.calls.at(-1)![0]!;
    expect(callArg.where).toEqual(
      expect.objectContaining({
        projectId: 'p-1',
        type: 'activity',
        assigneeId: { not: null },
        plannedStartDate: { not: null },
        plannedEndDate: { not: null },
      }),
    );
  });
});
