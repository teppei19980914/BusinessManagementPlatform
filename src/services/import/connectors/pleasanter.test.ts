import { describe, it, expect, vi } from 'vitest';
import {
  extractPleasanterField,
  pleasanterRecordsToCsvSource,
  pleasanterRecordsToWbsSource,
  pleasanterDiscover,
  pleasanterFetchSources,
  type PleasanterRecord,
} from './pleasanter';
import { buildBatchFromCsv } from '../csv-to-batch';
import type { FetchLike } from './http';

describe('extractPleasanterField', () => {
  const rec: PleasanterRecord = {
    IssueId: 10,
    Title: '設計',
    Status: '実行中',
    ClassHash: { ClassA: '親20' },
    NumHash: { WorkValueUser: 8 },
    DescriptionHash: { Body: '本文' },
  };
  it('トップレベルを優先', () => {
    expect(extractPleasanterField(rec, 'Title')).toBe('設計');
    expect(extractPleasanterField(rec, 'Status')).toBe('実行中');
    expect(extractPleasanterField(rec, 'IssueId')).toBe('10');
  });
  it('Hash 内のユーザ定義カラムを探す', () => {
    expect(extractPleasanterField(rec, 'ClassA')).toBe('親20');
    expect(extractPleasanterField(rec, 'WorkValueUser')).toBe('8');
    expect(extractPleasanterField(rec, 'Body')).toBe('本文');
  });
  it('無いキーは空', () => {
    expect(extractPleasanterField(rec, 'Nope')).toBe('');
  });
});

describe('pleasanterRecordsToCsvSource (Results→課題)', () => {
  const records: PleasanterRecord[] = [{ ResultId: 1, Title: '課題A', DescriptionHash: { Body: '詳細' } }];
  it('課題として既存経路に流れる', () => {
    const src = pleasanterRecordsToCsvSource(records, 'risk', { title: 'Title', content: 'Body' });
    const batch = buildBatchFromCsv([src]);
    expect(batch.externalRisks[0].data.title).toBe('課題A');
    expect(batch.externalRisks[0].data.content).toBe('詳細');
  });
});

describe('pleasanterRecordsToWbsSource (Issues, ClassX 親リンク)', () => {
  const records: PleasanterRecord[] = [
    { IssueId: 20, Title: '基本設計', StartTime: '2026-06-01', WorkValue: 8, ClassHash: { ClassA: '10' } },
    { IssueId: 10, Title: '設計WP', ClassHash: { ClassA: '' } },
  ];
  it('ClassA を親リンクに階層復元', () => {
    const { source } = pleasanterRecordsToWbsSource(records, {
      idKey: 'IssueId',
      nameKey: 'Title',
      parentKey: 'ClassA',
      projectName: 'PJ',
      startKey: 'StartTime',
      effortKey: 'WorkValue',
    });
    const grp = buildBatchFromCsv([source]).externalWbs[0];
    expect(grp.rows.map((r) => [r.name, r.type])).toEqual([
      ['設計WP', 'work_package'],
      ['基本設計', 'activity'],
    ]);
    const act = grp.rows.find((r) => r.name === '基本設計')!;
    expect(act.plannedStartDate).toBe('2026-06-01');
    expect(act.plannedEffort).toBe(8);
  });
});

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => '' } as unknown as Response;
}

describe('pleasanterDiscover (fetch 注入)', () => {
  it('getsite で ReferenceType + カラム、Wikis は除外', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.includes('/site10/getsite')) {
        return jsonRes({ StatusCode: 200, Response: { ReferenceType: 'Issues', EditorColumnHash: { General: ['Title', 'StartTime', 'ClassA'] } } });
      }
      if (url.includes('/site99/getsite')) {
        return jsonRes({ StatusCode: 200, Response: { ReferenceType: 'Wikis' } });
      }
      throw new Error(`unexpected ${url}`);
    });
    const schema = await pleasanterDiscover(
      { token: 'k', baseUrl: 'https://pleasanter.net/fs', extra: { siteIds: 'site10,site99' } },
      { fetchImpl },
    );
    expect(schema.sources).toHaveLength(1);
    expect(schema.sources[0].entityHint).toBe('wbs');
    expect(schema.sources[0].fields.map((f) => f.key)).toEqual(['Title', 'StartTime', 'ClassA']);
    expect(schema.warnings.some((w) => w.includes('Wiki'))).toBe(true);
    // ApiKey は JSON ボディ
    const body = JSON.parse((fetchImpl.mock.calls[0][1]?.body as string) ?? '{}');
    expect(body.ApiKey).toBe('k');
    expect(body.ApiVersion).toBe(1.1);
  });
});

describe('pleasanterFetchSources (Offset ページング)', () => {
  it('TotalCount まで PageSize 刻みで取得', async () => {
    const all = [
      { IssueId: 1, Title: 'A' },
      { IssueId: 2, Title: 'B' },
      { IssueId: 3, Title: 'C' },
    ];
    const fetchImpl = vi.fn<FetchLike>(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      const offset = body.Offset ?? 0;
      const slice = all.slice(offset, offset + 2);
      return jsonRes({ StatusCode: 200, Response: { Offset: offset, PageSize: 2, TotalCount: all.length, Data: slice } });
    });
    const { sources } = await pleasanterFetchSources(
      { token: 'k', baseUrl: 'https://host' },
      { mappings: [{ sourceId: 'site1', entity: 'risk', columnMap: { title: 'Title' } }] },
      { fetchImpl },
    );
    expect(sources[0].rows).toEqual([{ Title: 'A' }, { Title: 'B' }, { Title: 'C' }]);
  });
});
