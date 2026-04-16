import { describe, it, expect } from 'vitest';
import { validateWbsTemplate, parseCsvTemplate, parseCsvLine } from './task.service';
import type { WbsTemplateTask } from '@/lib/validators/task';

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
});
