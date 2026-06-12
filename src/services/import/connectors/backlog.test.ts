import { describe, it, expect, vi } from 'vitest';
import {
  backlogToCsvSources,
  backlogDiscover,
  backlogFetchSources,
  type BacklogIssue,
} from './backlog';
import { buildBatchFromCsv } from '../csv-to-batch';
import type { FetchLike } from './http';

// 公式サンプル (developer.nulab.com) を最小化したフィクスチャ
const project = { id: 1, projectKey: 'BLG', name: '移行プロジェクト' };

// issueType: 2=Task(WBS扱い), 3=Bug(課題扱い)
const issues: BacklogIssue[] = [
  { id: 10, summary: '設計フェーズ', issueType: { id: 2, name: 'Task' }, parentIssueId: null },
  { id: 11, summary: '基本設計', issueType: { id: 2, name: 'Task' }, parentIssueId: 10, startDate: '2026-06-01', dueDate: '2026-06-10', estimatedHours: 8 },
  { id: 12, summary: '詳細設計', issueType: { id: 2, name: 'Task' }, parentIssueId: 10, startDate: '2026-06-11', dueDate: '2026-06-20', estimatedHours: 12 },
  { id: 20, summary: 'ログイン不具合', issueType: { id: 3, name: 'Bug' }, parentIssueId: null, description: '500 エラー', dueDate: '2026-06-15' },
];

describe('backlogToCsvSources (純変換 → CsvEntitySource → 既存パイプライン)', () => {
  it('issueType で WBS と課題を振り分け、既存経路で WP/ACT を構造判定', () => {
    const { sources } = backlogToCsvSources({ project, issues, wbsIssueTypeIds: [2] });
    const batch = buildBatchFromCsv(sources);
    expect(batch.source).toBe('csv'); // buildBatchFromCsv 経由のため source は csv (経路一致の証跡)
    const p = batch.projects[0];
    expect(p.name).toBe('移行プロジェクト');
    expect(p.wbs.map((r) => [r.name, r.level, r.type])).toEqual([
      ['設計フェーズ', 1, 'work_package'],
      ['基本設計', 2, 'activity'],
      ['詳細設計', 2, 'activity'],
    ]);
    // 課題: Bug → リスク・課題 (project に紐づく)
    expect(p.risks).toHaveLength(1);
    expect(p.risks[0]).toMatchObject({ type: 'issue', title: 'ログイン不具合', content: '500 エラー', deadline: '2026-06-15' });
  });

  it('ACT は予定日/工数を保持、WP(親) は捨てる', () => {
    const { sources } = backlogToCsvSources({ project, issues, wbsIssueTypeIds: [2] });
    const wbs = buildBatchFromCsv(sources).projects[0].wbs;
    const wp = wbs.find((r) => r.name === '設計フェーズ')!;
    const act = wbs.find((r) => r.name === '基本設計')!;
    expect(wp.plannedStartDate).toBeNull();
    expect(act.plannedStartDate).toBe('2026-06-01');
    expect(act.plannedEffort).toBe(8);
  });

  it('customerName 指定で顧客を作り project に紐づける', () => {
    const { sources } = backlogToCsvSources({ project, issues, wbsIssueTypeIds: [2], customerName: '株式会社サンプル' });
    const batch = buildBatchFromCsv(sources);
    expect(batch.customers.map((c) => c.name)).toEqual(['株式会社サンプル']);
    expect(batch.projects[0].customerRef).toBe('株式会社サンプル');
  });

  it('customerName 未指定なら顧客なし・customerRef は null', () => {
    const { sources } = backlogToCsvSources({ project, issues, wbsIssueTypeIds: [2] });
    const batch = buildBatchFromCsv(sources);
    expect(batch.customers).toEqual([]);
    expect(batch.projects[0].customerRef).toBeNull();
  });

  it('WBS 対象 issueType が無ければ WBS 空・全て課題', () => {
    const { sources } = backlogToCsvSources({ project, issues, wbsIssueTypeIds: [] });
    const batch = buildBatchFromCsv(sources);
    expect(batch.projects[0].wbs).toEqual([]);
    expect(batch.projects[0].risks).toHaveLength(4);
  });
});

// --- HTTP (fetch 注入) ---

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => '' } as unknown as Response;
}

describe('backlogDiscover (fetch 注入)', () => {
  it('projects + issueTypes を field 化、subtasking 無効は警告', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.includes('/api/v2/projects/1/issueTypes')) {
        return jsonRes([{ id: 2, name: 'タスク' }, { id: 3, name: 'バグ' }]);
      }
      if (url.includes('/api/v2/projects')) {
        return jsonRes([{ id: 1, projectKey: 'BLG', name: '移行PJ', subtaskingEnabled: false }]);
      }
      throw new Error(`unexpected ${url}`);
    });
    const schema = await backlogDiscover({ token: 'k', baseUrl: 'https://x.backlog.com/' }, { fetchImpl });
    expect(schema.sources[0].id).toBe('1');
    expect(schema.sources[0].fields.map((f) => f.key)).toEqual(['issueType:2', 'issueType:3']);
    expect(schema.warnings.some((w) => w.includes('サブタスク'))).toBe(true);
  });

  it('ベースURL 未入力はエラー警告のみ', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes([]));
    const schema = await backlogDiscover({ token: 'k' }, { fetchImpl });
    expect(schema.sources).toEqual([]);
    expect(schema.warnings.length).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('backlogFetchSources (count+offset ページング)', () => {
  it('issues/count → issues を offset 取得し正規化', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.includes('/api/v2/issues/count')) return jsonRes({ count: 4 });
      if (url.includes('/api/v2/issues?') || url.includes('/api/v2/issues&')) return jsonRes(issues);
      if (url.includes('/api/v2/issues')) return jsonRes(issues);
      if (url.includes('/api/v2/projects')) return jsonRes([project]);
      throw new Error(`unexpected ${url}`);
    });
    const { sources, warnings } = await backlogFetchSources(
      { token: 'k', baseUrl: 'https://x.backlog.com' },
      { mappings: [{ sourceId: '1', entity: 'wbs', columnMap: {}, options: { wbsIssueTypeIds: [2] } }] },
      { fetchImpl },
    );
    const batch = buildBatchFromCsv(sources);
    expect(batch.projects[0].wbs).toHaveLength(3);
    expect(batch.projects[0].risks).toHaveLength(1);
    expect(warnings).toEqual([]);
    // apiKey がクエリに乗っていること
    const countCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/issues/count'))!;
    expect(String(countCall[0])).toContain('apiKey=k');
  });
});
