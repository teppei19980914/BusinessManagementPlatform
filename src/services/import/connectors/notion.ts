/**
 * 外部移行インポート — Notion コネクタ (ADR-0034 / IMPORT_CONNECTORS.md §1)
 *
 * 公式: developers.notion.com / Notion-Version: 2026-03-11 / ベース https://api.notion.com
 *
 * 重要な現行仕様 (2026-06 公式再確認済):
 *   - DB の行取得は data_sources 経由が必須 (2025-09-03 アップグレード)。
 *     databases/{id} → data_sources[] 解決 → POST data_sources/{ds}/query (メソッドは POST)。
 *   - ページング: start_cursor / has_more / next_cursor、page_size 最大 100。
 *   - レート: 平均 3 req/s。429 + Retry-After (http.ts のバックオフが順守)。
 *   - 認証: Internal Integration Token + capability「Read content」。Authorization: Bearer + Notion-Version。
 *     対象 DB/ページはインテグレーションに手動共有が必要 (未共有はエラー)。
 *   - people の email は capability「User information (with email)」が無いと取得不可 (id/name のみ)。
 *
 * 責務分離:
 *   - extractNotionProperty / notionPagesToCsvSource / notionPagesToWbsSource は**純関数** (HTTP なし)。
 *   - discover / fetchSources のみ HTTP を伴う (http.ts の fetchJson を使用)。
 */

import { fetchJson, collectByCursor, type HttpClientOptions } from './http';
import { wbsNodesToCsvRows, WBS_ROW_COLUMN_MAP } from './wbs-rows';
import type { SourceWbsNode } from '../wbs-hierarchy';
import type { CsvEntitySource, CsvRow } from '../csv-to-batch';
import type {
  ConnectorAuth,
  ConnectorMapping,
  DiscoveredField,
  DiscoveredSchema,
  DiscoveredSource,
  MigrationConnector,
} from './types';

const NOTION_BASE = 'https://api.notion.com';
const NOTION_VERSION = '2026-03-11';
const PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Notion レスポンスの最小型 (本コネクタが参照するフィールドのみ)
// ---------------------------------------------------------------------------

export interface NotionPropertyValue {
  id?: string;
  type: string;
  // 型ごとの値は type をキーに持つ (例: { type:'title', title:[...] })。
  [key: string]: unknown;
}

export interface NotionPage {
  id: string;
  properties: Record<string, NotionPropertyValue>;
}

interface NotionRichText {
  plain_text?: string;
}

// ---------------------------------------------------------------------------
// 純関数: プロパティ抽出
// ---------------------------------------------------------------------------

function joinRichText(arr: unknown): string {
  if (!Array.isArray(arr)) return '';
  return (arr as NotionRichText[]).map((t) => t?.plain_text ?? '').join('');
}

/**
 * Notion のプロパティ値オブジェクト → 文字列 (CSV セル相当)。
 * 取り込み先で value-mapping / date-normalize が処理するため、ここでは「素の表示文字列」に揃える。
 * relation は関連先ページ id をカンマ連結で返す (WBS 親参照・顧客参照などに使う)。
 */
export function extractNotionProperty(prop: NotionPropertyValue | undefined | null): string {
  if (!prop) return '';
  const type = prop.type;
  const v = prop[type];

  switch (type) {
    case 'title':
    case 'rich_text':
      return joinRichText(v);
    case 'number':
      return v == null ? '' : String(v);
    case 'select':
    case 'status':
      return (v as { name?: string } | null)?.name ?? '';
    case 'multi_select':
      return Array.isArray(v) ? (v as { name?: string }[]).map((o) => o?.name ?? '').join(', ') : '';
    case 'date':
      return (v as { start?: string } | null)?.start ?? '';
    case 'people':
      return Array.isArray(v)
        ? (v as { name?: string; person?: { email?: string } }[])
            .map((p) => p?.name ?? p?.person?.email ?? '')
            .filter((s) => s !== '')
            .join(', ')
        : '';
    case 'checkbox':
      return v === true ? 'true' : v === false ? 'false' : '';
    case 'email':
    case 'phone_number':
    case 'url':
      return typeof v === 'string' ? v : '';
    case 'created_time':
    case 'last_edited_time':
      return typeof v === 'string' ? v : '';
    case 'unique_id': {
      const u = v as { prefix?: string | null; number?: number } | null;
      if (!u || u.number == null) return '';
      return u.prefix ? `${u.prefix}-${u.number}` : String(u.number);
    }
    case 'formula': {
      const f = v as NotionPropertyValue | null;
      return f ? extractNotionProperty(f) : '';
    }
    case 'relation':
      return Array.isArray(v) ? (v as { id?: string }[]).map((r) => r?.id ?? '').filter(Boolean).join(', ') : '';
    default:
      return '';
  }
}

/** ページ全体を「プロパティ名 → 抽出文字列」の行へ。指定したプロパティ名のみ抽出。 */
function pageToRow(page: NotionPage, propertyNames: string[]): CsvRow {
  const row: CsvRow = {};
  for (const name of propertyNames) {
    row[name] = extractNotionProperty(page.properties[name]);
  }
  return row;
}

/** columnMap の値 (ソース項目名) の集合を返す。 */
function usedPropertyNames(columnMap: Record<string, string>, extra: (string | undefined)[] = []): string[] {
  const set = new Set<string>();
  for (const v of Object.values(columnMap)) if (v) set.add(v);
  for (const e of extra) if (e) set.add(e);
  return [...set];
}

// ---------------------------------------------------------------------------
// 純関数: pages → CsvEntitySource
// ---------------------------------------------------------------------------

/**
 * 非WBSエンティティ: Notion ページ列 → CsvEntitySource (1 ページ = 1 行)。
 * columnMap は「たすきばfield → Notion プロパティ名」(= 既存CSV経路の columnMap と同義)。
 */
export function notionPagesToCsvSource(
  pages: NotionPage[],
  entity: CsvEntitySource['entity'],
  columnMap: Record<string, string>,
  fixedMap?: Record<string, string>,
): CsvEntitySource {
  const propNames = usedPropertyNames(columnMap);
  return {
    entity,
    rows: pages.map((p) => pageToRow(p, propNames)),
    columnMap,
    fixedMap,
  };
}

/**
 * WBSエンティティ: Notion ページ列 → レベル列つき CsvEntitySource。
 * sub-item relation (parentKey で指定したプロパティ) を親参照として親子グラフを組み、
 * wbs-rows で前順序+レベルに直列化する。
 *
 * @param nameKey  名称に使う Notion プロパティ名 (通常 title)
 * @param parentKey 親ページ id を持つ relation プロパティ名 (sub-item)
 * @param projectName この WBS 群が属するプロジェクト名
 * @param dateKeys  予定日/工数のプロパティ名 (任意)
 */
export function notionPagesToWbsSource(
  pages: NotionPage[],
  params: {
    nameKey: string;
    parentKey?: string;
    projectName: string;
    startKey?: string;
    endKey?: string;
    effortKey?: string;
  },
): { source: CsvEntitySource; warnings: string[] } {
  const nodes: SourceWbsNode[] = pages.map((p) => {
    const parentRaw = params.parentKey ? extractNotionProperty(p.properties[params.parentKey]) : '';
    // relation は「id, id」連結。WBS 親は単一前提のため先頭のみ採用。
    const parentId = parentRaw.split(',')[0]?.trim() || null;
    const effortRaw = params.effortKey ? extractNotionProperty(p.properties[params.effortKey]) : '';
    const effort = effortRaw !== '' && Number.isFinite(Number(effortRaw)) ? Number(effortRaw) : null;
    return {
      sourceId: p.id,
      parentSourceId: parentId,
      name: extractNotionProperty(p.properties[params.nameKey]),
      plannedStartDate: params.startKey ? extractNotionProperty(p.properties[params.startKey]) || null : null,
      plannedEndDate: params.endKey ? extractNotionProperty(p.properties[params.endKey]) || null : null,
      plannedEffort: effort,
    };
  });
  const { rows, warnings } = wbsNodesToCsvRows(nodes, params.projectName);
  return {
    source: { entity: 'wbs', rows, columnMap: WBS_ROW_COLUMN_MAP },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// HTTP: discover / fetch
// ---------------------------------------------------------------------------

function notionHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
  };
}

interface NotionSearchResult {
  results: { id: string; title?: NotionRichText[]; name?: string; object: string }[];
}

interface NotionDataSource {
  id: string;
  name?: string;
  title?: NotionRichText[];
  properties: Record<string, { id: string; name: string; type: string }>;
}

interface NotionQueryResult {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

function dataSourceTitle(ds: { name?: string; title?: NotionRichText[] }): string {
  if (ds.name) return ds.name;
  return joinRichText(ds.title) || '(無題)';
}

function propsToFields(properties: NotionDataSource['properties']): DiscoveredField[] {
  return Object.values(properties).map((p) => ({ key: p.name, label: p.name, type: p.type }));
}

/**
 * discover: インテグレーションに共有済みの data_source を列挙し、各スキーマ (properties) を返す。
 * トークンは本呼出の間だけ使用し、呼出側 (route) が直後に破棄する。
 */
export async function notionDiscover(auth: ConnectorAuth, http: HttpClientOptions = {}): Promise<DiscoveredSchema> {
  const headers = notionHeaders(auth.token);
  const warnings: string[] = [];

  // 1) data_source オブジェクトを検索で列挙
  const search = await fetchJson<NotionSearchResult>(
    {
      url: `${NOTION_BASE}/v1/search`,
      method: 'POST',
      headers,
      body: { filter: { property: 'object', value: 'data_source' }, page_size: PAGE_SIZE },
    },
    http,
  );

  const sources: DiscoveredSource[] = [];
  for (const r of search.results) {
    // 2) 各 data_source のスキーマ (properties) を取得
    const ds = await fetchJson<NotionDataSource>(
      { url: `${NOTION_BASE}/v1/data_sources/${r.id}`, headers },
      http,
    );
    sources.push({ id: ds.id, name: dataSourceTitle(ds), fields: propsToFields(ds.properties) });
  }

  if (sources.length === 0) {
    warnings.push(
      '取得できるデータベースがありませんでした。Notion 側で移行対象の DB をインテグレーションに共有しているか確認してください。',
    );
  }
  return { source: 'notion', sources, warnings };
}

/** 1 つの data_source の全ページを cursor ページングで取得。 */
async function queryAllPages(
  dataSourceId: string,
  headers: Record<string, string>,
  http: HttpClientOptions,
): Promise<NotionPage[]> {
  return collectByCursor<NotionPage>(async (cursor) => {
    const res = await fetchJson<NotionQueryResult>(
      {
        url: `${NOTION_BASE}/v1/data_sources/${dataSourceId}/query`,
        method: 'POST',
        headers,
        body: { page_size: PAGE_SIZE, start_cursor: cursor },
      },
      http,
    );
    return { items: res.results, nextCursor: res.has_more ? res.next_cursor : null };
  });
}

/**
 * fetchSources: マッピングに従い各 data_source を取得し CsvEntitySource[] に正規化する。
 * WBS 由来の警告は warnings 経由で呼出側へ返す (previewMigrationFromSources に渡す)。
 */
export async function notionFetchSources(
  auth: ConnectorAuth,
  mapping: ConnectorMapping,
  http: HttpClientOptions = {},
): Promise<{ sources: CsvEntitySource[]; warnings: string[] }> {
  const headers = notionHeaders(auth.token);
  const out: CsvEntitySource[] = [];
  const warnings: string[] = [];

  for (const m of mapping.mappings) {
    const pages = await queryAllPages(m.sourceId, headers, http);
    if (m.entity === 'wbs') {
      const projectName = m.fixedMap?.projectName ?? '';
      const { source, warnings: w } = notionPagesToWbsSource(pages, {
        nameKey: m.columnMap.name ?? 'Name',
        parentKey: m.parentKey,
        projectName,
        startKey: m.columnMap.plannedStartDate,
        endKey: m.columnMap.plannedEndDate,
        effortKey: m.columnMap.plannedEffort,
      });
      out.push(source);
      warnings.push(...w);
    } else {
      out.push(notionPagesToCsvSource(pages, m.entity, m.columnMap, m.fixedMap));
    }
  }
  return { sources: out, warnings };
}

/** MigrationConnector 実装 (warnings は fetchSources 内部で握り、ここでは sources のみ返す薄いラッパ)。 */
export const notionConnector: MigrationConnector = {
  source: 'notion',
  discover: (auth) => notionDiscover(auth),
  fetchSources: async (auth, mapping) => (await notionFetchSources(auth, mapping)).sources,
};
