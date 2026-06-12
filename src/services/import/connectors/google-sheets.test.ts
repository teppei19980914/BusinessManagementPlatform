import { describe, it, expect, vi } from 'vitest';
import {
  sheetValuesToCsvSource,
  headerToFields,
  sheetsDiscover,
  sheetsFetchSources,
} from './google-sheets';
import { buildBatchFromCsv } from '../csv-to-batch';
import type { FetchLike } from './http';

describe('sheetValuesToCsvSource', () => {
  it('ヘッダ+行を CsvRow 化、短い行は右パディング', () => {
    const values = [
      ['顧客名', '部門', '備考'],
      ['株式会社A', '営業部'], // 備考が欠落 (空セル省略)
      ['株式会社B', '開発部', 'VIP'],
    ];
    const src = sheetValuesToCsvSource(values, 'customer', { name: '顧客名', department: '部門', notes: '備考' });
    expect(src.rows).toEqual([
      { 顧客名: '株式会社A', 部門: '営業部', 備考: '' },
      { 顧客名: '株式会社B', 部門: '開発部', 備考: 'VIP' },
    ]);
    const batch = buildBatchFromCsv([src]);
    expect(batch.customers.map((c) => [c.name, c.department])).toEqual([
      ['株式会社A', '営業部'],
      ['株式会社B', '開発部'],
    ]);
  });

  it('空ヘッダ列は無視', () => {
    const src = sheetValuesToCsvSource([['名称', ''], ['A', 'x']], 'customer', { name: '名称' });
    expect(src.rows).toEqual([{ 名称: 'A' }]);
  });

  it('WBS はレベル列方式で既存CSV経路にそのまま流れる', () => {
    const values = [
      ['プロジェクト名', 'レベル', '名称'],
      ['PJ', '1', '設計WP'],
      ['PJ', '2', '基本設計'],
    ];
    const src = sheetValuesToCsvSource(values, 'wbs', { projectName: 'プロジェクト名', level: 'レベル', name: '名称' });
    const grp = buildBatchFromCsv([src]).externalWbs[0];
    expect(grp.rows.map((r) => [r.name, r.type])).toEqual([
      ['設計WP', 'work_package'],
      ['基本設計', 'activity'],
    ]);
  });

  it('values 空でも壊れない', () => {
    expect(sheetValuesToCsvSource(undefined, 'customer', {}).rows).toEqual([]);
  });
});

describe('headerToFields', () => {
  it('空・空白を除外して field 化', () => {
    expect(headerToFields(['A', ' ', 'B'])).toEqual([
      { key: 'A', label: 'A', type: 'text' },
      { key: 'B', label: 'B', type: 'text' },
    ]);
  });
});

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => '' } as unknown as Response;
}

describe('sheetsDiscover (fetch 注入)', () => {
  it('タブ列挙 → 各ヘッダ行を field 化', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.includes('fields=sheets.properties.title')) {
        return jsonRes({ sheets: [{ properties: { title: '顧客' } }] });
      }
      return jsonRes({ values: [['顧客名', '部門']] });
    });
    const schema = await sheetsDiscover({ token: 'oauth', extra: { spreadsheetId: 'sid' } }, { fetchImpl });
    expect(schema.sources[0]).toMatchObject({ id: '顧客', name: '顧客' });
    expect(schema.sources[0].fields.map((f) => f.key)).toEqual(['顧客名', '部門']);
    // OAuth Bearer
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer oauth');
  });

  it('API キー指定時は ?key= を付ける (Bearer なし)', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes({ sheets: [] }));
    await sheetsDiscover({ token: '', extra: { spreadsheetId: 'sid', apiKey: 'AIza' } }, { fetchImpl });
    expect(String(fetchImpl.mock.calls[0][0])).toContain('key=AIza');
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe('sheetsFetchSources', () => {
  it('タブの values を取得して正規化', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes({ values: [['名称'], ['A'], ['B']] }));
    const { sources } = await sheetsFetchSources(
      { token: 'o', extra: { spreadsheetId: 'sid' } },
      { mappings: [{ sourceId: '顧客', entity: 'customer', columnMap: { name: '名称' } }] },
      { fetchImpl },
    );
    expect(sources[0].rows).toEqual([{ 名称: 'A' }, { 名称: 'B' }]);
  });
});
