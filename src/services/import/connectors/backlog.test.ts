import { describe, it, expect } from 'vitest';
import { backlogToNormalizedBatch, type BacklogIssue } from './backlog';

// 公式サンプル (developer.nulab.com) を最小化したフィクスチャ
const project = { id: 1, projectKey: 'BLG', name: '移行プロジェクト' };

// issueType: 2=Task(WBS扱い), 3=Bug(課題扱い)
const issues: BacklogIssue[] = [
  { id: 10, summary: '設計フェーズ', issueType: { id: 2, name: 'Task' }, parentIssueId: null },
  { id: 11, summary: '基本設計', issueType: { id: 2, name: 'Task' }, parentIssueId: 10, startDate: '2026-06-01', dueDate: '2026-06-10', estimatedHours: 8 },
  { id: 12, summary: '詳細設計', issueType: { id: 2, name: 'Task' }, parentIssueId: 10, startDate: '2026-06-11', dueDate: '2026-06-20', estimatedHours: 12 },
  { id: 20, summary: 'ログイン不具合', issueType: { id: 3, name: 'Bug' }, parentIssueId: null, description: '500 エラー', dueDate: '2026-06-15' },
];

describe('backlogToNormalizedBatch', () => {
  it('issueType で WBS と課題を振り分ける', () => {
    const batch = backlogToNormalizedBatch({ project, issues, wbsIssueTypeIds: [2] });
    expect(batch.source).toBe('backlog');
    const p = batch.projects[0];
    expect(p.name).toBe('移行プロジェクト');
    expect(p.sourceKey).toBe('BLG');
    // WBS: 設計フェーズ(子あり=WP) → 基本設計/詳細設計(葉=ACT)
    expect(p.wbs.map((r) => [r.name, r.level, r.type])).toEqual([
      ['設計フェーズ', 1, 'work_package'],
      ['基本設計', 2, 'activity'],
      ['詳細設計', 2, 'activity'],
    ]);
    // 課題: Bug → リスク・課題
    expect(p.risks).toHaveLength(1);
    expect(p.risks[0]).toMatchObject({ type: 'issue', title: 'ログイン不具合', content: '500 エラー', deadline: '2026-06-15', visibility: 'draft' });
  });

  it('ACT は予定日/工数を保持、WP(親) は捨てる', () => {
    const batch = backlogToNormalizedBatch({ project, issues, wbsIssueTypeIds: [2] });
    const wbs = batch.projects[0].wbs;
    const wp = wbs.find((r) => r.name === '設計フェーズ')!;
    const act = wbs.find((r) => r.name === '基本設計')!;
    expect(wp.plannedStartDate).toBeNull();
    expect(act.plannedStartDate).toBe('2026-06-01');
    expect(act.plannedEffort).toBe(8);
  });

  it('customerName 指定で顧客を作り project に紐づける', () => {
    const batch = backlogToNormalizedBatch({ project, issues, wbsIssueTypeIds: [2], customerName: '株式会社サンプル' });
    expect(batch.customers).toEqual([{ sourceKey: '株式会社サンプル', name: '株式会社サンプル' }]);
    expect(batch.projects[0].customerRef).toBe('株式会社サンプル');
  });

  it('customerName 未指定なら customerRef は null', () => {
    const batch = backlogToNormalizedBatch({ project, issues, wbsIssueTypeIds: [2] });
    expect(batch.customers).toEqual([]);
    expect(batch.projects[0].customerRef).toBeNull();
  });

  it('WBS 対象 issueType が無ければ WBS 空・全て課題', () => {
    const batch = backlogToNormalizedBatch({ project, issues, wbsIssueTypeIds: [] });
    expect(batch.projects[0].wbs).toEqual([]);
    expect(batch.projects[0].risks).toHaveLength(4);
  });
});
