import { describe, it, expect } from 'vitest';
import type { TaskDTO } from '@/services/task.service';
import {
  collectAllIds,
  collectSelfAndDescendantIds,
  filterTreeByAssignee,
  filterTreeByStatus,
  UNASSIGNED_KEY,
} from './task-tree-utils';

function makeTask(overrides: Partial<TaskDTO>): TaskDTO {
  return {
    id: 'x',
    projectId: 'p1',
    parentTaskId: null,
    type: 'activity',
    wbsNumber: null,
    name: 'x',
    description: null,
    assigneeId: null,
    plannedStartDate: null,
    plannedEndDate: null,
    actualStartDate: null,
    actualEndDate: null,
    plannedEffort: 0,
    priority: null,
    status: 'not_started',
    progressRate: 0,
    isMilestone: false,
    notes: null,
    ...overrides,
  };
}

describe('collectAllIds', () => {
  it('空配列は空配列を返す', () => {
    expect(collectAllIds([])).toEqual([]);
  });

  it('フラットなリストから全 ID を収集する', () => {
    const tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b' }), makeTask({ id: 'c' })];
    expect(collectAllIds(tasks)).toEqual(['a', 'b', 'c']);
  });

  it('ネストした WP/ACT から再帰的に全 ID を収集する', () => {
    const tasks: TaskDTO[] = [
      makeTask({
        id: 'wp1',
        type: 'work_package',
        children: [
          makeTask({ id: 'act1', parentTaskId: 'wp1' }),
          makeTask({
            id: 'wp1-1',
            type: 'work_package',
            parentTaskId: 'wp1',
            children: [makeTask({ id: 'act2', parentTaskId: 'wp1-1' })],
          }),
        ],
      }),
      makeTask({ id: 'orphan' }),
    ];
    expect(collectAllIds(tasks)).toEqual(['wp1', 'act1', 'wp1-1', 'act2', 'orphan']);
  });
});

describe('collectSelfAndDescendantIds', () => {
  const tree: TaskDTO[] = [
    makeTask({
      id: 'wp1',
      type: 'work_package',
      children: [
        makeTask({ id: 'act1', parentTaskId: 'wp1' }),
        makeTask({
          id: 'wp1-1',
          type: 'work_package',
          parentTaskId: 'wp1',
          children: [
            makeTask({ id: 'act2', parentTaskId: 'wp1-1' }),
            makeTask({ id: 'act3', parentTaskId: 'wp1-1' }),
          ],
        }),
      ],
    }),
    makeTask({ id: 'wp2', type: 'work_package', children: [] }),
  ];

  it('ルート WP を指定すると自身 + 全子孫を返す', () => {
    expect(collectSelfAndDescendantIds(tree, 'wp1')).toEqual(['wp1', 'act1', 'wp1-1', 'act2', 'act3']);
  });

  it('中間 WP を指定するとその WP 以下のサブツリーを返す（親は含まない）', () => {
    expect(collectSelfAndDescendantIds(tree, 'wp1-1')).toEqual(['wp1-1', 'act2', 'act3']);
  });

  it('リーフ ACT を指定するとその ACT 自身のみを返す', () => {
    expect(collectSelfAndDescendantIds(tree, 'act2')).toEqual(['act2']);
  });

  it('子を持たない WP を指定するとその WP 自身のみを返す', () => {
    expect(collectSelfAndDescendantIds(tree, 'wp2')).toEqual(['wp2']);
  });

  it('ツリーに存在しない ID を指定すると空配列を返す', () => {
    expect(collectSelfAndDescendantIds(tree, 'nonexistent')).toEqual([]);
  });

  it('空ツリーでも空配列を返す', () => {
    expect(collectSelfAndDescendantIds([], 'wp1')).toEqual([]);
  });
});

describe('filterTreeByAssignee', () => {
  /**
   * テスト用ツリー:
   *   wp1 (未アサイン)
   *     ├ act1 (user-A)
   *     └ wp1-1 (未アサイン)
   *         ├ act2 (user-B)
   *         └ act3 (未アサイン)
   *   wp2 (未アサイン, 子無し)
   */
  const tree: TaskDTO[] = [
    makeTask({
      id: 'wp1',
      type: 'work_package',
      assigneeId: null,
      children: [
        makeTask({ id: 'act1', parentTaskId: 'wp1', assigneeId: 'user-A' }),
        makeTask({
          id: 'wp1-1',
          type: 'work_package',
          parentTaskId: 'wp1',
          assigneeId: null,
          children: [
            makeTask({ id: 'act2', parentTaskId: 'wp1-1', assigneeId: 'user-B' }),
            makeTask({ id: 'act3', parentTaskId: 'wp1-1', assigneeId: null }),
          ],
        }),
      ],
    }),
    makeTask({ id: 'wp2', type: 'work_package', assigneeId: null, children: [] }),
  ];

  it('全員 + 未アサイン選択時は元ツリーを完全に保持する', () => {
    const selected = new Set(['user-A', 'user-B', UNASSIGNED_KEY]);
    const result = filterTreeByAssignee(tree, selected);
    expect(collectAllIds(result)).toEqual(['wp1', 'act1', 'wp1-1', 'act2', 'act3', 'wp2']);
  });

  it('user-A のみ選択時は act1 のみ残し、親 WP は階層維持のため残す', () => {
    const selected = new Set(['user-A']);
    const result = filterTreeByAssignee(tree, selected);
    // wp1 は子孫 act1 が該当するため残る。wp1-1 と wp2 は配下に該当者なしで除外
    expect(collectAllIds(result)).toEqual(['wp1', 'act1']);
  });

  it('user-B のみ選択時は wp1 → wp1-1 → act2 の階層だけが残る', () => {
    const selected = new Set(['user-B']);
    const result = filterTreeByAssignee(tree, selected);
    expect(collectAllIds(result)).toEqual(['wp1', 'wp1-1', 'act2']);
  });

  it('未アサインのみ選択時は担当者未設定のタスクとその祖先のみ残る', () => {
    const selected = new Set([UNASSIGNED_KEY]);
    const result = filterTreeByAssignee(tree, selected);
    // wp1 (未), wp1-1 (未) と act3 (未), wp2 (未) が残る
    expect(collectAllIds(result)).toEqual(['wp1', 'wp1-1', 'act3', 'wp2']);
  });

  it('選択なし（空セット）では全タスクが除外される', () => {
    const result = filterTreeByAssignee(tree, new Set());
    expect(result).toEqual([]);
  });

  it('空ツリー入力でも空配列を返す', () => {
    const selected = new Set(['user-A']);
    expect(filterTreeByAssignee([], selected)).toEqual([]);
  });

  it('元ツリーを破壊的に変更しない (immutable)', () => {
    const selected = new Set(['user-A']);
    const snapshotIds = collectAllIds(tree);
    filterTreeByAssignee(tree, selected);
    expect(collectAllIds(tree)).toEqual(snapshotIds);
  });
});

describe('filterTreeByStatus (PR #61)', () => {
  /**
   * テスト用ツリー:
   *   wp1 (not_started)
   *     ├ act1 (in_progress)
   *     └ wp1-1 (not_started)
   *         ├ act2 (completed)
   *         └ act3 (on_hold)
   *   wp2 (not_started, 子無し)
   */
  const tree: TaskDTO[] = [
    makeTask({
      id: 'wp1',
      type: 'work_package',
      status: 'not_started',
      children: [
        makeTask({ id: 'act1', parentTaskId: 'wp1', status: 'in_progress' }),
        makeTask({
          id: 'wp1-1',
          type: 'work_package',
          parentTaskId: 'wp1',
          status: 'not_started',
          children: [
            makeTask({ id: 'act2', parentTaskId: 'wp1-1', status: 'completed' }),
            makeTask({ id: 'act3', parentTaskId: 'wp1-1', status: 'on_hold' }),
          ],
        }),
      ],
    }),
    makeTask({ id: 'wp2', type: 'work_package', status: 'not_started', children: [] }),
  ];

  it('全ステータス選択時は元ツリーを完全に保持する', () => {
    const selected = new Set(['not_started', 'in_progress', 'completed', 'on_hold']);
    const result = filterTreeByStatus(tree, selected);
    expect(collectAllIds(result)).toEqual(['wp1', 'act1', 'wp1-1', 'act2', 'act3', 'wp2']);
  });

  it('in_progress のみ選択時は act1 と祖先 wp1 のみ残る', () => {
    const selected = new Set(['in_progress']);
    const result = filterTreeByStatus(tree, selected);
    expect(collectAllIds(result)).toEqual(['wp1', 'act1']);
  });

  it('completed のみ選択時は act2 と祖先 wp1, wp1-1 のみ残る', () => {
    const selected = new Set(['completed']);
    const result = filterTreeByStatus(tree, selected);
    expect(collectAllIds(result)).toEqual(['wp1', 'wp1-1', 'act2']);
  });

  it('選択なし (空) は全除外', () => {
    const result = filterTreeByStatus(tree, new Set());
    expect(result).toEqual([]);
  });

  it('空ツリーでも空配列を返す', () => {
    expect(filterTreeByStatus([], new Set(['in_progress']))).toEqual([]);
  });
});
