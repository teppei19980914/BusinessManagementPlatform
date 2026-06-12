import { describe, it, expect, vi } from 'vitest';
import {
  extractKintoneValue,
  kintoneRecordsToCsvSource,
  kintoneRecordsToWbsSource,
  kintoneDiscover,
  kintoneFetchSources,
  type KintoneRecord,
} from './kintone';
import { buildBatchFromCsv } from '../csv-to-batch';
import type { FetchLike } from './http';

describe('extractKintoneValue', () => {
  it('単純型は value を文字列化 (NUMBER/DATE は元から文字列)', () => {
    expect(extractKintoneValue({ type: 'SINGLE_LINE_TEXT', value: '案件A' })).toBe('案件A');
    expect(extractKintoneValue({ type: 'NUMBER', value: '8' })).toBe('8');
    expect(extractKintoneValue({ type: 'DATE', value: '2026-06-01' })).toBe('2026-06-01');
    expect(extractKintoneValue({ type: 'DROP_DOWN', value: '高' })).toBe('高');
  });
  it('CHECK_BOX / MULTI_SELECT は連結', () => {
    expect(extractKintoneValue({ type: 'CHECK_BOX', value: ['a', 'b'] })).toBe('a, b');
  });
  it('USER_SELECT は name 連結', () => {
    expect(extractKintoneValue({ type: 'USER_SELECT', value: [{ code: 'u1', name: '山田' }] })).toBe('山田');
  });
  it('CREATOR は name', () => {
    expect(extractKintoneValue({ type: 'CREATOR', value: { code: 'u', name: '作成者' } })).toBe('作成者');
  });
  it('SUBTABLE / FILE / REFERENCE_TABLE は除外 (空)', () => {
    expect(extractKintoneValue({ type: 'SUBTABLE', value: [{}] })).toBe('');
    expect(extractKintoneValue({ type: 'REFERENCE_TABLE', value: undefined })).toBe('');
  });
  it('null は空', () => {
    expect(extractKintoneValue(null)).toBe('');
  });
});

describe('kintoneRecordsToCsvSource (非WBS → 既存パイプライン)', () => {
  const records: KintoneRecord[] = [
    {
      $id: { type: '__ID__', value: '1' },
      件名: { type: 'SINGLE_LINE_TEXT', value: '本番障害' },
      種別: { type: 'DROP_DOWN', value: '障害対応' },
    },
  ];
  it('field コードでたすきばfield を引き、既存経路で検証', () => {
    const src = kintoneRecordsToCsvSource(records, 'knowledge', { title: '件名', knowledgeType: '種別' });
    expect(src.rows).toEqual([{ 件名: '本番障害', 種別: '障害対応' }]);
    const batch = buildBatchFromCsv([src]);
    expect(batch.externalKnowledge[0].data.title).toBe('本番障害');
    expect(batch.valueErrors).toEqual([]); // 「障害対応」は既知値
  });
});

describe('kintoneRecordsToWbsSource', () => {
  const records: KintoneRecord[] = [
    { $id: { type: '__ID__', value: '20' }, 名称: { type: 'SINGLE_LINE_TEXT', value: '基本設計' }, 親: { type: 'NUMBER', value: '10' }, 工数: { type: 'NUMBER', value: '8' } },
    { $id: { type: '__ID__', value: '10' }, 名称: { type: 'SINGLE_LINE_TEXT', value: '設計WP' }, 親: { type: 'NUMBER', value: '' } },
  ];
  it('parentKey で親子グラフ → 前順序+レベル', () => {
    const { source } = kintoneRecordsToWbsSource(records, { nameKey: '名称', parentKey: '親', projectName: 'PJ', effortKey: '工数' });
    const grp = buildBatchFromCsv([source]).externalWbs[0];
    expect(grp.rows.map((r) => [r.name, r.type])).toEqual([
      ['設計WP', 'work_package'],
      ['基本設計', 'activity'],
    ]);
  });
  it('parentKey 未指定は全フラット (全 level 1)', () => {
    const { source } = kintoneRecordsToWbsSource(records, { nameKey: '名称', projectName: 'PJ' });
    expect(source.rows.every((r) => r.level === '1')).toBe(true);
  });
});

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => '' } as unknown as Response;
}

describe('kintoneDiscover (fetch 注入)', () => {
  it('form/fields を field 化、REFERENCE_TABLE は除外', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonRes({
        properties: {
          件名: { code: '件名', label: '件名', type: 'SINGLE_LINE_TEXT' },
          関連: { code: '関連', label: '関連レコード', type: 'REFERENCE_TABLE' },
        },
      }),
    );
    const schema = await kintoneDiscover({ token: 't', baseUrl: 'https://x.kintone.com', extra: { appIds: '5' } }, { fetchImpl });
    expect(schema.sources[0].fields.map((f) => f.key)).toEqual(['件名']);
    // X-Cybozu-API-Token ヘッダ
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>)['X-Cybozu-API-Token']).toBe('t');
  });
  it('appId 未指定は警告のみ', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes({}));
    const schema = await kintoneDiscover({ token: 't', baseUrl: 'https://x.kintone.com' }, { fetchImpl });
    expect(schema.sources).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('kintoneFetchSources (カーソル API)', () => {
  it('cursor 作成 → next=false まで取得', async () => {
    const pages = [
      { records: [{ $id: { type: '__ID__', value: '1' }, 件名: { type: 'SINGLE_LINE_TEXT', value: 'A' } }], next: true },
      { records: [{ $id: { type: '__ID__', value: '2' }, 件名: { type: 'SINGLE_LINE_TEXT', value: 'B' } }], next: false },
    ];
    let getCalls = 0;
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      if (init?.method === 'POST') return jsonRes({ id: 'cur1', totalCount: '2' });
      return jsonRes(pages[getCalls++]);
    });
    const { sources } = await kintoneFetchSources(
      { token: 't', baseUrl: 'https://x.kintone.com' },
      { mappings: [{ sourceId: '5', entity: 'risk', columnMap: { title: '件名' } }] },
      { fetchImpl },
    );
    expect(sources[0].rows).toEqual([{ 件名: 'A' }, { 件名: 'B' }]);
  });
});
