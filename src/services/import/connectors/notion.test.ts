import { describe, it, expect, vi } from 'vitest';
import {
  extractNotionProperty,
  notionPagesToCsvSource,
  notionPagesToWbsSource,
  notionDiscover,
  notionFetchSources,
  type NotionPage,
  type NotionPropertyValue,
} from './notion';
import type { FetchLike } from './http';
import { buildBatchFromCsv } from '../csv-to-batch';

function prop(type: string, value: unknown): NotionPropertyValue {
  return { id: 'x', type, [type]: value };
}

describe('extractNotionProperty', () => {
  it('title / rich_text は plain_text を連結', () => {
    expect(extractNotionProperty(prop('title', [{ plain_text: '設計' }, { plain_text: 'フェーズ' }]))).toBe(
      '設計フェーズ',
    );
    expect(extractNotionProperty(prop('rich_text', [{ plain_text: 'メモ' }]))).toBe('メモ');
  });
  it('number / checkbox', () => {
    expect(extractNotionProperty(prop('number', 8.5))).toBe('8.5');
    expect(extractNotionProperty(prop('checkbox', true))).toBe('true');
  });
  it('select / status / multi_select', () => {
    expect(extractNotionProperty(prop('select', { name: '高' }))).toBe('高');
    expect(extractNotionProperty(prop('status', { name: '実行中' }))).toBe('実行中');
    expect(extractNotionProperty(prop('multi_select', [{ name: 'A' }, { name: 'B' }]))).toBe('A, B');
  });
  it('date は start の日付部', () => {
    expect(extractNotionProperty(prop('date', { start: '2026-06-01', end: null }))).toBe('2026-06-01');
  });
  it('people は name、無ければ email', () => {
    expect(
      extractNotionProperty(prop('people', [{ name: '山田' }, { person: { email: 'a@b.c' } }])),
    ).toBe('山田, a@b.c');
  });
  it('relation は id 連結 / unique_id は prefix-number', () => {
    expect(extractNotionProperty(prop('relation', [{ id: 'p1' }, { id: 'p2' }]))).toBe('p1, p2');
    expect(extractNotionProperty(prop('unique_id', { prefix: 'TASK', number: 12 }))).toBe('TASK-12');
  });
  it('formula は内側の型へ再帰', () => {
    expect(extractNotionProperty(prop('formula', { type: 'number', number: 3 }))).toBe('3');
  });
  it('null / 未知型は空文字', () => {
    expect(extractNotionProperty(null)).toBe('');
    expect(extractNotionProperty(prop('files', []))).toBe('');
  });
});

describe('notionPagesToCsvSource (非WBS)', () => {
  const pages: NotionPage[] = [
    {
      id: 'pg1',
      properties: {
        タイトル: prop('title', [{ plain_text: '障害A' }]),
        種別: prop('select', { name: '障害対応' }),
        公開: prop('select', { name: '下書き' }),
      },
    },
  ];

  it('columnMap でたすきばfield ← Notionプロパティ名 を引く', () => {
    const src = notionPagesToCsvSource(pages, 'knowledge', {
      title: 'タイトル',
      knowledgeType: '種別',
      visibility: '公開',
    });
    expect(src.entity).toBe('knowledge');
    expect(src.rows).toEqual([{ タイトル: '障害A', 種別: '障害対応', 公開: '下書き' }]);
    // 既存パイプラインに流して、生値が保持され「選択肢として認識」されること (= valueError ゼロ) を確認。
    // 内部値化 (incident/draft) は batch-preview の buildImportPreview 段で行われる (経路一致の保証)。
    const batch = buildBatchFromCsv([src]);
    expect(batch.externalKnowledge[0].data.title).toBe('障害A');
    expect(batch.externalKnowledge[0].data.knowledgeType).toBe('障害対応'); // 生値保持
    expect(batch.valueErrors).toEqual([]); // 「障害対応」「下書き」は既存バリデータが既知値と認識
  });
});

describe('notionPagesToWbsSource (sub-item relation → 前順序+レベル)', () => {
  const pages: NotionPage[] = [
    // 順不同で与える (API は順不同)
    { id: 'c', properties: { 名称: prop('title', [{ plain_text: '基本設計' }]), 親: prop('relation', [{ id: 'p' }]), 工数: prop('number', 8) } },
    { id: 'p', properties: { 名称: prop('title', [{ plain_text: '設計WP' }]), 親: prop('relation', []) } },
  ];

  it('親子グラフをレベル列に直列化し、既存経路で WP/ACT を構造判定', () => {
    const { source } = notionPagesToWbsSource(pages, {
      nameKey: '名称',
      parentKey: '親',
      projectName: '移行案件',
      effortKey: '工数',
    });
    // 前順序: 親(設計WP) → 子(基本設計)
    expect(source.rows.map((r) => [r.name, r.level])).toEqual([
      ['設計WP', '1'],
      ['基本設計', '2'],
    ]);
    const batch = buildBatchFromCsv([
      // WBS は projectName で既存プロジェクトに紐づくため externalWbs に入る
      source,
    ]);
    const grp = batch.externalWbs[0];
    expect(grp.projectName).toBe('移行案件');
    expect(grp.rows.map((r) => [r.name, r.type])).toEqual([
      ['設計WP', 'work_package'],
      ['基本設計', 'activity'],
    ]);
  });
});

// --- HTTP (fetch 注入) ---

function jsonRes(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => '' } as unknown as Response;
}

describe('notionDiscover (fetch 注入)', () => {
  it('search で data_source 列挙 → 各スキーマ取得', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.endsWith('/v1/search')) {
        return jsonRes({ results: [{ id: 'ds1', name: 'タスクDB', object: 'data_source' }] });
      }
      if (url.endsWith('/v1/data_sources/ds1')) {
        return jsonRes({
          id: 'ds1',
          name: 'タスクDB',
          properties: { 名称: { id: 'a', name: '名称', type: 'title' }, 状態: { id: 'b', name: '状態', type: 'status' } },
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const schema = await notionDiscover({ token: 't' }, { fetchImpl });
    expect(schema.source).toBe('notion');
    expect(schema.sources).toHaveLength(1);
    expect(schema.sources[0]).toMatchObject({ id: 'ds1', name: 'タスクDB' });
    expect(schema.sources[0].fields.map((f) => f.key)).toEqual(['名称', '状態']);
  });

  it('共有ゼロは警告を返す', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes({ results: [] }));
    const schema = await notionDiscover({ token: 't' }, { fetchImpl });
    expect(schema.sources).toHaveLength(0);
    expect(schema.warnings.length).toBeGreaterThan(0);
  });
});

describe('notionFetchSources (cursor ページング + 認証ヘッダ)', () => {
  it('data_sources/{ds}/query を POST + Notion-Version で複数ページ取得', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      calls.push({ url, init });
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (!body.start_cursor) {
        return jsonRes({
          results: [{ id: 'pg1', properties: { 件名: prop('title', [{ plain_text: 'A' }]) } }],
          has_more: true,
          next_cursor: 'cur2',
        });
      }
      return jsonRes({
        results: [{ id: 'pg2', properties: { 件名: prop('title', [{ plain_text: 'B' }]) } }],
        has_more: false,
        next_cursor: null,
      });
    });

    const { sources } = await notionFetchSources(
      { token: 'secret' },
      { mappings: [{ sourceId: 'ds1', entity: 'risk', columnMap: { title: '件名' } }] },
      { fetchImpl },
    );
    expect(sources[0].rows).toEqual([{ 件名: 'A' }, { 件名: 'B' }]);
    // 認証ヘッダ確認
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret');
    expect(headers['Notion-Version']).toBe('2026-03-11');
    expect(calls[0].init?.method).toBe('POST');
  });
});
