import { describe, it, expect } from 'vitest';
import type { TaskDTO } from '@/services/task.service';
import { collectAllIds, collectSelfAndDescendantIds } from './task-tree-utils';

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
