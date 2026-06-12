import { describe, it, expect, vi, beforeEach } from 'vitest';

// PR #361 (2026-05-14): previewActivityWorkload テスト用に prisma を mock。
//   既存の pure 関数テスト (buildTree など) には影響しない。
vi.mock('@/lib/db', () => ({
  prisma: {
    task: {
      findMany: vi.fn(),
    },
    project: {
      findMany: vi.fn(),
    },
  },
}));

// PR-3 perf (2026-05-29): listMyTaskProjects 内で動的 import される helper を mock。
//   テストランナー上では実装を返して通常通り filterTreeByAssignee を実行させる。
vi.mock('@/lib/task-tree-utils', () => ({
  filterTreeByAssignee: (tree: TaskDTO[], assignees: Set<string>): TaskDTO[] => {
    function walk(node: TaskDTO): TaskDTO | null {
      const matched = node.assigneeId ? assignees.has(node.assigneeId) : false;
      const children = (node.children ?? []).map(walk).filter(Boolean) as TaskDTO[];
      if (matched || children.length > 0) return { ...node, children };
      return null;
    }
    return tree.map(walk).filter(Boolean) as TaskDTO[];
  },
}));

import {
  parseCsvLine,
  parseCsvText,
  buildTree,
  aggregateWpFromChildren,
  normalizeActualDatesForStatus,
  normalizeProgressForStatus,
  isWpAggregationEqual,
  previewActivityWorkload,
  listMyTaskProjects,
  type WpAggregationChild,
  type WpAggregationResult,
} from './task.service';
import type { TaskDTO } from './task.service';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';

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
    actualEffort: null,
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

// fix/csv-import-multiline-text-data-loss: RFC 4180 準拠 multi-line cell パーサ。
//   旧 split(/\r?\n/) + parseCsvLine 組み合わせの bug (2 行目以降欠落) 再発防止のため、
//   round-trip テストで multi-line セルの保護を担保する。
describe('parseCsvText (multi-line cell 対応)', () => {
  it('header + data 1 行をパースできる', () => {
    const csv = 'ID,タイトル,本文\nk-1,T1,C1';
    expect(parseCsvText(csv)).toEqual([
      ['ID', 'タイトル', '本文'],
      ['k-1', 'T1', 'C1'],
    ]);
  });

  it('CRLF (Windows 改行) も LF も等価に扱う', () => {
    expect(parseCsvText('a,b\r\n1,2\r\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
    expect(parseCsvText('a,b\n1,2\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('UTF-8 BOM を自動除去する', () => {
    const csv = '﻿ID,本文\nk-1,内容';
    expect(parseCsvText(csv)).toEqual([['ID', '本文'], ['k-1', '内容']]);
  });

  it('★★ quoted multi-line cell の 2 行目以降を欠落させない (本 PR の主目的)', () => {
    const csv = 'ID,本文,メタ\nk-1,"line1\nline2\nline3",public';
    const records = parseCsvText(csv);
    expect(records).toHaveLength(2);
    expect(records[1]).toEqual(['k-1', 'line1\nline2\nline3', 'public']);
  });

  it('quoted multi-line cell が CRLF を含んでも正しくパースできる', () => {
    const csv = 'ID,本文\r\nk-1,"line1\r\nline2"\r\nk-2,single';
    const records = parseCsvText(csv);
    expect(records).toHaveLength(3);
    expect(records[1][1]).toBe('line1\r\nline2');
    expect(records[2]).toEqual(['k-2', 'single']);
  });

  it('カンマ含むセル + ダブルクォートエスケープ + 改行を同時に処理できる', () => {
    const csv = 'ID,本文\nk-1,"a, b\nc ""quoted"" d"';
    const records = parseCsvText(csv);
    expect(records[1][1]).toBe('a, b\nc "quoted" d');
  });

  it('空 CSV は空配列を返す', () => {
    expect(parseCsvText('')).toEqual([]);
  });

  it('完全な空行はスキップされる (CSV 末尾の trailing \\n 対応)', () => {
    expect(parseCsvText('a,b\n1,2\n\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('列数が行ごとに異なっても許容する (relax_column_count)', () => {
    expect(parseCsvText('a,b,c\n1,2\n3,4,5,6')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2'],
      ['3', '4', '5', '6'],
    ]);
  });

  // fix/csv-import-multiline-text-data-loss 2 巡目: csv-parse は malformed CSV で throw する。
  //   呼出側 (API route) で catch → 400 化する責務を持たせる前提を保証するため。
  it('閉じてないクォート (EOF) で CsvError throw する', () => {
    expect(() => parseCsvText('id,body\n1,"unclosed')).toThrowError(/CSV_QUOTE_NOT_CLOSED|Quote Not Closed/i);
  });

  it('クォート閉じの直後に余計な文字があると CsvError throw する', () => {
    expect(() => parseCsvText('id,body\n1,"a"x,trailing')).toThrowError(/CSV_INVALID_CLOSING_QUOTE|Invalid Closing Quote/i);
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

// ================================================================
// PR #361 (2026-05-14): previewActivityWorkload テスト
// ================================================================

describe('previewActivityWorkload', () => {
  const TENANT_A = '11111111-1111-1111-1111-111111111111';
  const PROJECT_ID = 'proj-1';
  const ASSIGNEE = 'user-A';
  const BASE_INPUT = {
    projectId: PROJECT_ID,
    assigneeId: ASSIGNEE,
    viewerTenantId: TENANT_A,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('既存タスクなし + 新規入力 2 日 × 8h → 1 日 4h (= max=4.0, ok)', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);
    const r = await previewActivityWorkload({
      ...BASE_INPUT,
      startDate: '2026-06-15',
      endDate: '2026-06-16',
      plannedEffort: 8,
    });
    expect(r.maxDailyEffort).toBe(4);
    expect(r.maxDailyDate).toBe('2026-06-15');
    expect(r.level).toBe('ok');
  });

  it('既存と期間重複 → 重なる日の合算 max (alert)', async () => {
    // 既存タスク: 2026-06-15 のみ 5h (1 日完結)
    vi.mocked(prisma.task.findMany).mockResolvedValue([
      {
        plannedStartDate: new Date('2026-06-15T00:00:00.000Z'),
        plannedEndDate: new Date('2026-06-15T00:00:00.000Z'),
        plannedEffort: 5,
      },
    ] as never);
    // 入力: 2026-06-15〜06-16 で 8h (1 日 4h ずつ)
    const r = await previewActivityWorkload({
      ...BASE_INPUT,
      startDate: '2026-06-15',
      endDate: '2026-06-16',
      plannedEffort: 8,
    });
    // 06-15: 5 (既存) + 4 (新規) = 9.0h → alert (8h 超)
    expect(r.maxDailyEffort).toBe(9);
    expect(r.maxDailyDate).toBe('2026-06-15');
    expect(r.level).toBe('alert');
  });

  it('期間重複なし → 各日の max が独立、新規分のみが max', async () => {
    // 既存: 2026-06-10 のみ 3h
    vi.mocked(prisma.task.findMany).mockResolvedValue([
      {
        plannedStartDate: new Date('2026-06-10T00:00:00.000Z'),
        plannedEndDate: new Date('2026-06-10T00:00:00.000Z'),
        plannedEffort: 3,
      },
    ] as never);
    // 入力: 2026-06-15 (1 日) × 7.5h
    const r = await previewActivityWorkload({
      ...BASE_INPUT,
      startDate: '2026-06-15',
      endDate: '2026-06-15',
      plannedEffort: 7.5,
    });
    // 既存 06-10 は入力期間外なので max に含まれない、06-15 は 7.5h
    expect(r.maxDailyEffort).toBe(7.5);
    expect(r.maxDailyDate).toBe('2026-06-15');
    expect(r.level).toBe('warning'); // 7.5 > 7
  });

  it('excludeTaskId で自タスク除外 (編集時の二重カウント防止)', async () => {
    // excludeTaskId='task-edit-self' を指定 → findMany の where に id: { not: 'task-edit-self' } が含まれること
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);
    await previewActivityWorkload({
      ...BASE_INPUT,
      startDate: '2026-06-15',
      endDate: '2026-06-15',
      plannedEffort: 4,
      excludeTaskId: 'task-edit-self',
    });
    const call = vi.mocked(prisma.task.findMany).mock.calls[0]![0]!;
    const where = call.where as { id?: { not: string } };
    expect(where.id).toEqual({ not: 'task-edit-self' });
  });

  it('plannedEffort=0 → max=0 (ok)', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);
    const r = await previewActivityWorkload({
      ...BASE_INPUT,
      startDate: '2026-06-15',
      endDate: '2026-06-15',
      plannedEffort: 0,
    });
    expect(r.maxDailyEffort).toBe(0);
    expect(r.level).toBe('ok');
  });

  it('startDate > endDate → max=0, maxDailyDate=null', async () => {
    const r = await previewActivityWorkload({
      ...BASE_INPUT,
      startDate: '2026-06-20',
      endDate: '2026-06-15',
      plannedEffort: 8,
    });
    expect(r.maxDailyEffort).toBe(0);
    expect(r.maxDailyDate).toBeNull();
    expect(r.level).toBe('ok');
    // 不正期間は早期 return = findMany を呼ばない
    expect(prisma.task.findMany).not.toHaveBeenCalled();
  });

  // ★ テナント分離 (severity-1): where 句に project.tenantId フィルタが必須
  it('[テナント分離] findMany の where に project: { tenantId: viewerTenantId } を必須付与', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValue([] as never);
    await previewActivityWorkload({
      ...BASE_INPUT,
      startDate: '2026-06-15',
      endDate: '2026-06-15',
      plannedEffort: 4,
    });
    const call = vi.mocked(prisma.task.findMany).mock.calls[0]![0]!;
    const where = call.where as { project?: { tenantId: string } };
    expect(where.project).toEqual({ tenantId: TENANT_A });
  });
});

// PR-3 perf (2026-05-29): listMyTaskProjects の N+1 解消が結果に影響しないことを担保。
//   旧実装: projects 数 N に対して N 回 listTasks (= N 回 findMany)。
//   新実装: 1 回の findMany で全プロジェクト分のタスクを取得し JS グルーピング。
describe('listMyTaskProjects (PR-3 perf: N+1 解消の同等性検証)', () => {
  const USER = '00000000-0000-0000-0000-000000000aaa';
  const TENANT = '00000000-0000-0000-0000-0000000000aa';
  const PROJECT_A = '00000000-0000-0000-0000-00000000000a';
  const PROJECT_B = '00000000-0000-0000-0000-00000000000b';

  beforeEach(() => {
    vi.mocked(prisma.task.findMany).mockReset();
    vi.mocked(prisma.project.findMany).mockReset();
  });

  function taskFixture(overrides: {
    id: string;
    projectId: string;
    name?: string;
    parentTaskId?: string | null;
    assigneeId?: string | null;
    type?: 'work_package' | 'activity';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): any {
    return {
      id: overrides.id,
      projectId: overrides.projectId,
      name: overrides.name ?? `task-${overrides.id}`,
      type: overrides.type ?? 'activity',
      parentTaskId: overrides.parentTaskId ?? null,
      assigneeId: overrides.assigneeId ?? USER,
      status: 'not_started',
      plannedStartDate: null,
      plannedEndDate: null,
      plannedEffort: dec(1),
      actualStartDate: null,
      actualEndDate: null,
      progressRate: 0,
      description: null,
      createdBy: USER,
      updatedBy: USER,
      createdAt: new Date('2026-05-29T00:00:00Z'),
      updatedAt: new Date('2026-05-29T00:00:00Z'),
      deletedAt: null,
      assignee: { name: 'Alice' },
      parentTask: overrides.parentTaskId ? { name: 'parent' } : null,
    };
  }

  it('プロジェクト 0 件のとき空配列を返し、後続クエリが発行されないこと', async () => {
    vi.mocked(prisma.task.findMany).mockResolvedValueOnce([]);

    const result = await listMyTaskProjects(USER, TENANT);

    expect(result).toEqual([]);
    expect(prisma.task.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it('複数プロジェクトでも DB ラウンドトリップが固定 3 回 (assignments / projects / tasks) に収まること', async () => {
    vi.mocked(prisma.task.findMany)
      // assignments query (担当 ACT の projectId)
      .mockResolvedValueOnce([
        { projectId: PROJECT_A },
        { projectId: PROJECT_A },
        { projectId: PROJECT_B },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any)
      // all tasks across projects (PR-3 で 1 回に統合)
      .mockResolvedValueOnce([
        taskFixture({ id: 'a1', projectId: PROJECT_A }),
        taskFixture({ id: 'a2', projectId: PROJECT_A }),
        taskFixture({ id: 'b1', projectId: PROJECT_B }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any);
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([
      { id: PROJECT_A, name: 'Alpha' },
      { id: PROJECT_B, name: 'Beta' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);

    const result = await listMyTaskProjects(USER, TENANT);

    // 結果がプロジェクト名順 + 各プロジェクトのタスクが正しく分配されていること
    expect(result).toHaveLength(2);
    expect(result[0]!.projectName).toBe('Alpha');
    expect(result[1]!.projectName).toBe('Beta');
    expect(result[0]!.tree.map((t) => t.id).sort()).toEqual(['a1', 'a2']);
    expect(result[1]!.tree.map((t) => t.id)).toEqual(['b1']);

    // PR-3 の本質: findMany が **2 回** (assignments + 全タスク) のみ。
    // 旧実装はプロジェクト数 N に対し findMany が N+1 回呼ばれていた。
    expect(prisma.task.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.project.findMany).toHaveBeenCalledTimes(1);
  });

  it('全タスク取得クエリに viewerTenantId フィルタが含まれている (severity-1 越境防御)', async () => {
    vi.mocked(prisma.task.findMany)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce([{ projectId: PROJECT_A }] as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce([] as any);
    vi.mocked(prisma.project.findMany).mockResolvedValueOnce([
      { id: PROJECT_A, name: 'Alpha' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);

    await listMyTaskProjects(USER, TENANT);

    const secondCall = vi.mocked(prisma.task.findMany).mock.calls[1]![0]!;
    const where = secondCall.where as { project?: { tenantId: string } };
    expect(where.project).toEqual({ tenantId: TENANT });
  });
});
