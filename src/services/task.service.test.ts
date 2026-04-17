import { describe, it, expect } from 'vitest';
import {
  validateWbsTemplate,
  parseCsvTemplate,
  parseCsvLine,
  buildTree,
  aggregateWpFromChildren,
  normalizeActualDatesForStatus,
  normalizeProgressForStatus,
  type WpAggregationChild,
} from './task.service';
import type { TaskDTO } from './task.service';
import type { WbsTemplateTask } from '@/lib/validators/task';
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

describe('validateWbsTemplate', () => {
  const wp: WbsTemplateTask = {
    tempId: 'wp1',
    parentTempId: null,
    type: 'work_package',
    name: 'テストWP',
  };

  const act: WbsTemplateTask = {
    tempId: 'act1',
    parentTempId: 'wp1',
    type: 'activity',
    name: 'テストACT',
    plannedStartDate: '2026-05-01',
    plannedEndDate: '2026-05-15',
    plannedEffort: 16,
  };

  it('正常なテンプレートはエラーなし', () => {
    expect(validateWbsTemplate([wp, act])).toEqual([]);
  });

  it('存在しない親を参照するとエラー', () => {
    const orphan: WbsTemplateTask = { ...act, tempId: 'act2', parentTempId: 'nonexistent' };
    const errors = validateWbsTemplate([wp, orphan]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('nonexistent');
    expect(errors[0]).toContain('存在しません');
  });

  it('tempId重複でエラー', () => {
    const dup: WbsTemplateTask = { ...wp, tempId: 'wp1', name: '重複WP' };
    const errors = validateWbsTemplate([wp, dup]);
    expect(errors.some((e) => e.includes('重複'))).toBe(true);
  });

  it('循環参照でエラー', () => {
    const a: WbsTemplateTask = { tempId: 'a', parentTempId: 'b', type: 'work_package', name: 'A' };
    const b: WbsTemplateTask = { tempId: 'b', parentTempId: 'a', type: 'work_package', name: 'B' };
    const errors = validateWbsTemplate([a, b]);
    expect(errors.some((e) => e.includes('循環参照'))).toBe(true);
  });

  it('アクティビティの親がアクティビティだとエラー', () => {
    const parentAct: WbsTemplateTask = { tempId: 'p', parentTempId: null, type: 'activity', name: '親ACT', plannedStartDate: '2026-05-01', plannedEndDate: '2026-05-15', plannedEffort: 8 };
    const childAct: WbsTemplateTask = { ...act, parentTempId: 'p' };
    const errors = validateWbsTemplate([parentAct, childAct]);
    expect(errors.some((e) => e.includes('ワークパッケージではありません'))).toBe(true);
  });

  it('ルートタスク（親なし）は正常', () => {
    const root: WbsTemplateTask = { tempId: 'r', parentTempId: null, type: 'work_package', name: 'ルート' };
    expect(validateWbsTemplate([root])).toEqual([]);
  });
});

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

describe('parseCsvTemplate', () => {
  const header = 'レベル,種別,名称,WBS番号,予定開始日,予定終了日,見積工数,優先度,マイルストーン,備考';

  it('正常なCSVをパースできる', () => {
    const csv = [
      header,
      '1,WP,設計フェーズ,,,,,,',
      '2,ACT,基本設計,,2026-05-01,2026-05-15,16,high,,',
    ].join('\n');

    const tasks = parseCsvTemplate(csv);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].type).toBe('work_package');
    expect(tasks[0].name).toBe('設計フェーズ');
    expect(tasks[0].parentTempId).toBeNull();
    expect(tasks[1].type).toBe('activity');
    expect(tasks[1].name).toBe('基本設計');
    expect(tasks[1].parentTempId).toBe(tasks[0].tempId);
    expect(tasks[1].priority).toBe('high');
  });

  it('ヘッダーのみのCSVは空配列を返す', () => {
    expect(parseCsvTemplate(header)).toEqual([]);
  });

  it('空文字列は空配列を返す', () => {
    expect(parseCsvTemplate('')).toEqual([]);
  });

  it('複数レベルの階層を正しく復元する', () => {
    const csv = [
      header,
      '1,WP,プロジェクト,,,,,,',
      '2,WP,フェーズ1,,,,,,',
      '3,ACT,タスクA,,2026-05-01,2026-05-15,8,medium,,',
      '2,WP,フェーズ2,,,,,,',
      '3,ACT,タスクB,,2026-06-01,2026-06-15,8,low,,',
    ].join('\n');

    const tasks = parseCsvTemplate(csv);
    expect(tasks).toHaveLength(5);
    // フェーズ1 の親はプロジェクト
    expect(tasks[1].parentTempId).toBe(tasks[0].tempId);
    // タスクA の親はフェーズ1
    expect(tasks[2].parentTempId).toBe(tasks[1].tempId);
    // フェーズ2 の親はプロジェクト（レベル2に戻る）
    expect(tasks[3].parentTempId).toBe(tasks[0].tempId);
    // タスクB の親はフェーズ2
    expect(tasks[4].parentTempId).toBe(tasks[3].tempId);
  });

  it('マイルストーン ○ を正しく認識する', () => {
    const csv = [header, '1,ACT,マイルストーン,,2026-05-01,2026-05-01,0,,○,'].join('\n');
    const tasks = parseCsvTemplate(csv);
    expect(tasks[0].isMilestone).toBe(true);
  });

  it('名前が空の行はスキップする', () => {
    const csv = [header, '1,WP,,,,,,,', '1,WP,有効な行,,,,,,'].join('\n');
    const tasks = parseCsvTemplate(csv);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe('有効な行');
  });

  it('BOM付きCSVを正しくパースできる', () => {
    const csv = '\uFEFF' + [header, '1,WP,テスト,,,,,,'].join('\n');
    const tasks = parseCsvTemplate(csv);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe('テスト');
  });

  it('CRLF改行のCSVを正しくパースできる', () => {
    const csv = [header, '1,WP,テスト,,,,,,'].join('\r\n');
    const tasks = parseCsvTemplate(csv);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe('テスト');
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
