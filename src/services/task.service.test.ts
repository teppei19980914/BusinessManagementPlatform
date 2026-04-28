import { describe, it, expect } from 'vitest';
import {
  parseCsvLine,
  buildTree,
  aggregateWpFromChildren,
  normalizeActualDatesForStatus,
  normalizeProgressForStatus,
  isWpAggregationEqual,
  type WpAggregationChild,
  type WpAggregationResult,
} from './task.service';
import type { TaskDTO } from './task.service';
import type { Prisma } from '@/generated/prisma/client';

// Prisma.Decimal の代わりにテスト用の軽量代替を提供。
// Number() で変換される前提なので primitive number / string どちらも受け付けられる。
const dec = (n: number): Prisma.Decimal => n as unknown as Prisma.Decimal;

function childFixture(overrides: Partial<WpAggregationChild>): WpAggregationChild {
  return {
    plannedEffort: dec(0),
    progressRate: 0,
    plannedStartDate: null,
    plannedEndDate: null,
    actualStartDate: null,
    actualEndDate: null,
    status: 'not_started',
    assigneeId: null,
    ...overrides,
  };
}

function baseDto(overrides: Partial<TaskDTO>): TaskDTO {
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

describe('buildTree', () => {
  it('parentTaskId で親子関係を組み立てる', () => {
    const tasks: TaskDTO[] = [
      baseDto({ id: 'wp1', type: 'work_package', name: 'WP1' }),
      baseDto({ id: 'act1', parentTaskId: 'wp1', name: 'ACT1' }),
      baseDto({ id: 'act2', parentTaskId: 'wp1', name: 'ACT2' }),
    ];
    const tree = buildTree(tasks);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe('wp1');
    expect(tree[0].children).toHaveLength(2);
    expect(tree[0].children!.map((c) => c.id)).toEqual(['act1', 'act2']);
  });

  it('親が存在しない要素は root として扱う（孤立ノードもドロップしない）', () => {
    const tasks: TaskDTO[] = [
      baseDto({ id: 'orphan', parentTaskId: 'missing-parent', name: 'Orphan' }),
    ];
    const tree = buildTree(tasks);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe('orphan');
  });

  it('flat と tree は独立したオブジェクトで構成される（片方の変更が他方に影響しない）', () => {
    const flat: TaskDTO[] = [
      baseDto({ id: 'wp1', type: 'work_package', name: 'WP1' }),
      baseDto({ id: 'act1', parentTaskId: 'wp1', name: 'ACT1' }),
    ];
    const tree = buildTree(flat);
    tree[0].name = 'MUTATED';
    // 元の flat 側は変更されない
    expect(flat[0].name).toBe('WP1');
  });
});

// (T-19 で削除) validateWbsTemplate / parseCsvTemplate は旧 10 列テンプレート専用関数。
// sync-import (7 列) に一本化したため task.service から除去済 (関連テストは task-sync-import.service.test.ts に集約)。

describe('parseCsvLine', () => {
  it('通常のCSV行をパースできる', () => {
    expect(parseCsvLine('1,WP,テスト,WBS-1,2026-05-01,2026-05-15,16,medium,,メモ'))
      .toEqual(['1', 'WP', 'テスト', 'WBS-1', '2026-05-01', '2026-05-15', '16', 'medium', '', 'メモ']);
  });

  it('ダブルクォートで囲まれたフィールドをパースできる', () => {
    expect(parseCsvLine('1,WP,"カンマ,含む名前",,,,,,,')).toEqual(['1', 'WP', 'カンマ,含む名前', '', '', '', '', '', '', '']);
  });

  it('エスケープされたダブルクォートを処理できる', () => {
    expect(parseCsvLine('1,WP,"名前""付き",,,,,,,')).toEqual(['1', 'WP', '名前"付き', '', '', '', '', '', '', '']);
  });
});

describe('aggregateWpFromChildren', () => {
  it('子が0件なら全値を初期値（0 / null / not_started）にする', () => {
    const result = aggregateWpFromChildren([]);
    expect(result).toEqual({
      plannedEffort: 0,
      progressRate: 0,
      plannedStartDate: null,
      plannedEndDate: null,
      actualStartDate: null,
      actualEndDate: null,
      status: 'not_started',
      assigneeId: null,
    });
  });

  it('子の工数合計・加重平均進捗率を計算する', () => {
    const children = [
      childFixture({ plannedEffort: dec(10), progressRate: 50 }),
      childFixture({ plannedEffort: dec(30), progressRate: 100 }),
    ];
    const result = aggregateWpFromChildren(children);
    expect(result.plannedEffort).toBe(40);
    // 加重平均: (10*50 + 30*100) / 40 = 87.5 → 四捨五入で 88
    expect(result.progressRate).toBe(88);
  });

  it('予定日付を子の最小開始〜最大終了で集計する', () => {
    const children = [
      childFixture({
        plannedStartDate: new Date('2026-05-01'),
        plannedEndDate: new Date('2026-05-10'),
      }),
      childFixture({
        plannedStartDate: new Date('2026-04-20'),
        plannedEndDate: new Date('2026-05-15'),
      }),
    ];
    const result = aggregateWpFromChildren(children);
    expect(result.plannedStartDate?.toISOString().split('T')[0]).toBe('2026-04-20');
    expect(result.plannedEndDate?.toISOString().split('T')[0]).toBe('2026-05-15');
  });

  it('子が全て completed のとき、実績日付を予定と同じロジック（最小開始〜最大終了）で集計する', () => {
    const children = [
      childFixture({
        status: 'completed',
        actualStartDate: new Date('2026-05-03'),
        actualEndDate: new Date('2026-05-08'),
      }),
      childFixture({
        status: 'completed',
        actualStartDate: new Date('2026-05-01'),
        actualEndDate: new Date('2026-05-12'),
      }),
    ];
    const result = aggregateWpFromChildren(children);
    expect(result.status).toBe('completed');
    expect(result.actualStartDate?.toISOString().split('T')[0]).toBe('2026-05-01');
    expect(result.actualEndDate?.toISOString().split('T')[0]).toBe('2026-05-12');
  });

  it('実績日付が全て null の子しかない場合は null を返す', () => {
    // 子が not_started のみ → WP も not_started → 両方 null
    const children = [childFixture({}), childFixture({})];
    const result = aggregateWpFromChildren(children);
    expect(result.actualStartDate).toBeNull();
    expect(result.actualEndDate).toBeNull();
  });

  it('子の一部が未完了のとき、実績終了日は null になる（WP ステータス != completed のため）', () => {
    // 完了した子と未着手の子が混在 → WP は in_progress
    // 実績開始は min(有効な値) で保持、実績終了は status != completed のため null
    const children = [
      childFixture({
        status: 'completed',
        actualStartDate: new Date('2026-05-01'),
        actualEndDate: new Date('2026-05-08'),
      }),
      childFixture({ status: 'not_started' }),
    ];
    const result = aggregateWpFromChildren(children);
    expect(result.status).toBe('in_progress');
    expect(result.actualStartDate?.toISOString().split('T')[0]).toBe('2026-05-01');
    expect(result.actualEndDate).toBeNull();
  });

  it('WP が in_progress のとき、子の actualEnd が存在しても実績終了日は null になる', () => {
    // 両方 in_progress で actualEnd も入力されているレアケース
    // → 親 WP は in_progress → 実績終了は null に正規化
    const children = [
      childFixture({
        status: 'in_progress',
        actualStartDate: new Date('2026-05-05'),
        actualEndDate: new Date('2026-05-10'),
      }),
      childFixture({
        status: 'in_progress',
        actualStartDate: new Date('2026-05-03'),
        actualEndDate: null,
      }),
    ];
    const result = aggregateWpFromChildren(children);
    expect(result.status).toBe('in_progress');
    expect(result.actualStartDate?.toISOString().split('T')[0]).toBe('2026-05-03');
    expect(result.actualEndDate).toBeNull();
  });

  it('子が全て completed ならステータスは completed', () => {
    const children = [
      childFixture({ status: 'completed' }),
      childFixture({ status: 'completed' }),
    ];
    expect(aggregateWpFromChildren(children).status).toBe('completed');
  });

  it('子に in_progress が含まれる場合は in_progress', () => {
    const children = [
      childFixture({ status: 'completed' }),
      childFixture({ status: 'in_progress' }),
    ];
    expect(aggregateWpFromChildren(children).status).toBe('in_progress');
  });

  it('子が全て not_started なら not_started', () => {
    const children = [
      childFixture({ status: 'not_started' }),
      childFixture({ status: 'not_started' }),
    ];
    expect(aggregateWpFromChildren(children).status).toBe('not_started');
  });

  // --- 担当者集約 (uniform-assignee) ---
  it('子の担当者がすべて同一（user-A）なら親の担当者も user-A', () => {
    const children = [
      childFixture({ assigneeId: 'user-A' }),
      childFixture({ assigneeId: 'user-A' }),
      childFixture({ assigneeId: 'user-A' }),
    ];
    expect(aggregateWpFromChildren(children).assigneeId).toBe('user-A');
  });

  it('子の担当者が混在（user-A と user-B）なら親の担当者は null', () => {
    const children = [
      childFixture({ assigneeId: 'user-A' }),
      childFixture({ assigneeId: 'user-B' }),
    ];
    expect(aggregateWpFromChildren(children).assigneeId).toBeNull();
  });

  it('子の担当者が一部 null と user-A 混在なら親の担当者は null', () => {
    const children = [
      childFixture({ assigneeId: 'user-A' }),
      childFixture({ assigneeId: null }),
    ];
    expect(aggregateWpFromChildren(children).assigneeId).toBeNull();
  });

  it('子が全て未アサイン (null) なら親の担当者も null', () => {
    const children = [childFixture({ assigneeId: null }), childFixture({ assigneeId: null })];
    expect(aggregateWpFromChildren(children).assigneeId).toBeNull();
  });

  it('子が 1 件のみで user-A なら親も user-A（単一子のケース）', () => {
    const children = [childFixture({ assigneeId: 'user-A' })];
    expect(aggregateWpFromChildren(children).assigneeId).toBe('user-A');
  });
});

describe('normalizeActualDatesForStatus', () => {
  const start = new Date('2026-05-01');
  const end = new Date('2026-05-10');

  it('status=not_started: 実績開始・終了ともクリア', () => {
    expect(normalizeActualDatesForStatus('not_started', start, end)).toEqual({
      actualStartDate: null,
      actualEndDate: null,
    });
  });

  it('status=in_progress: 実績開始は保持、実績終了はクリア', () => {
    expect(normalizeActualDatesForStatus('in_progress', start, end)).toEqual({
      actualStartDate: start,
      actualEndDate: null,
    });
  });

  it('status=on_hold: 実績開始は保持、実績終了はクリア（進行中と同じ扱い）', () => {
    expect(normalizeActualDatesForStatus('on_hold', start, end)).toEqual({
      actualStartDate: start,
      actualEndDate: null,
    });
  });

  it('status=completed: 両方保持', () => {
    expect(normalizeActualDatesForStatus('completed', start, end)).toEqual({
      actualStartDate: start,
      actualEndDate: end,
    });
  });

  it('status=in_progress + 実績開始 null: 両方 null でもエラーにならない', () => {
    expect(normalizeActualDatesForStatus('in_progress', null, null)).toEqual({
      actualStartDate: null,
      actualEndDate: null,
    });
  });

  it('status=completed + 実績終了のみ null: 実績開始は保持、終了は null のまま', () => {
    expect(normalizeActualDatesForStatus('completed', start, null)).toEqual({
      actualStartDate: start,
      actualEndDate: null,
    });
  });

  it('undefined を渡しても null として正規化される', () => {
    expect(normalizeActualDatesForStatus('in_progress', undefined, undefined)).toEqual({
      actualStartDate: null,
      actualEndDate: null,
    });
  });

  it('未知のステータス文字列は「completed 以外」として処理される（実績終了はクリア）', () => {
    expect(normalizeActualDatesForStatus('unknown_status', start, end)).toEqual({
      actualStartDate: start,
      actualEndDate: null,
    });
  });
});

describe('normalizeProgressForStatus', () => {
  it('status=completed: 進捗率は常に 100 に揃えられる（入力値 0 でも）', () => {
    expect(normalizeProgressForStatus('completed', 0)).toBe(100);
  });

  it('status=completed: 入力 50 でも 100 に揃える（ステータスと進捗の矛盾を解消）', () => {
    expect(normalizeProgressForStatus('completed', 50)).toBe(100);
  });

  it('status=completed: 入力が undefined でも 100 を返す', () => {
    expect(normalizeProgressForStatus('completed', undefined)).toBe(100);
  });

  it('status=in_progress: 入力値をそのまま返す', () => {
    expect(normalizeProgressForStatus('in_progress', 42)).toBe(42);
  });

  it('status=not_started: 入力値をそのまま返す（完了以外は書き換えない設計）', () => {
    expect(normalizeProgressForStatus('not_started', 0)).toBe(0);
    expect(normalizeProgressForStatus('not_started', 30)).toBe(30);
  });

  it('status=on_hold: 入力値をそのまま返す', () => {
    expect(normalizeProgressForStatus('on_hold', 70)).toBe(70);
  });

  it('未知のステータスは入力値をそのまま返す', () => {
    expect(normalizeProgressForStatus('unknown', 55)).toBe(55);
  });
});

describe('isWpAggregationEqual', () => {
  const baseResult: WpAggregationResult = {
    plannedEffort: 40,
    progressRate: 50,
    plannedStartDate: new Date('2026-05-01'),
    plannedEndDate: new Date('2026-05-10'),
    actualStartDate: new Date('2026-05-02'),
    actualEndDate: null,
    status: 'in_progress',
    assigneeId: 'user-A',
  };

  it('全フィールド同値なら true', () => {
    expect(isWpAggregationEqual({ ...baseResult }, baseResult)).toBe(true);
  });

  it('plannedEffort の Decimal 表現を number 比較できる', () => {
    const current = { ...baseResult, plannedEffort: dec(40) };
    expect(isWpAggregationEqual(current, baseResult)).toBe(true);
  });

  it('progressRate が異なれば false', () => {
    const current = { ...baseResult, progressRate: 60 };
    expect(isWpAggregationEqual(current, baseResult)).toBe(false);
  });

  it('Date の時刻が同じなら true（参照が別でも getTime() 一致で判定）', () => {
    const current = { ...baseResult, plannedStartDate: new Date('2026-05-01') };
    expect(isWpAggregationEqual(current, baseResult)).toBe(true);
  });

  it('Date の時刻が異なれば false', () => {
    const current = { ...baseResult, plannedStartDate: new Date('2026-04-30') };
    expect(isWpAggregationEqual(current, baseResult)).toBe(false);
  });

  it('片方 null / もう片方 Date なら false', () => {
    const current = { ...baseResult, actualStartDate: null };
    expect(isWpAggregationEqual(current, baseResult)).toBe(false);
  });

  it('両方 null なら true (actualEndDate 同士)', () => {
    const result = { ...baseResult, actualEndDate: null };
    const current = { ...baseResult, actualEndDate: null };
    expect(isWpAggregationEqual(current, result)).toBe(true);
  });

  it('status が異なれば false', () => {
    const current = { ...baseResult, status: 'completed' };
    expect(isWpAggregationEqual(current, baseResult)).toBe(false);
  });

  it('assigneeId が異なれば false', () => {
    const current = { ...baseResult, assigneeId: 'user-B' };
    expect(isWpAggregationEqual(current, baseResult)).toBe(false);
  });

  it('assigneeId: undefined と null は同値扱い', () => {
    const result: WpAggregationResult = { ...baseResult, assigneeId: null };
    const current = { ...baseResult, assigneeId: null as string | null };
    expect(isWpAggregationEqual(current, result)).toBe(true);
  });
});
