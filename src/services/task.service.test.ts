import { describe, it, expect } from 'vitest';
import { validateWbsTemplate } from './task.service';
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
