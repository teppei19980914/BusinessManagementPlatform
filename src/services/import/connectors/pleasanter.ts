/**
 * 外部移行インポート — Pleasanter (プリザンター) コネクタ (ADR-0034 / IMPORT_CONNECTORS.md §4)
 *
 * 公式: pleasanter.org/manual / ApiVersion 1.1 / オンプレ・クラウド両対応
 *
 * 現行仕様の要点:
 *   - 認証: ApiKey を **JSON ボディ** に "ApiKey" で渡す (ヘッダでない)。"ApiVersion":1.1 併記。
 *     read 限定は鍵が紐づくユーザの権限で担保 (閲覧専用ユーザ)。
 *   - ベースURL: オンプレ `{base}/api/...` vs クラウド `https://pleasanter.net/fs/api/...` (/fs)。ユーザ入力で吸収。
 *   - エンドポイント (全て POST/JSON):
 *       {base}/api/items/{siteId}/get      → {StatusCode, Response:{Offset,PageSize,TotalCount,Data[]}}
 *       {base}/api/items/{siteId}/getsite  → {Response:{ReferenceType, EditorColumnHash, ...}}
 *   - ReferenceType: Issues(期限付き)→WBS / Results(記録)→課題 / Wikis→除外。
 *   - 表示名解決: View に "ApiDataType":"KeyValues" を指定すると Status/Owner/Manager 等が表示名で返る。
 *   - ページング: PageSize 既定/最大 200、Offset を 200 ずつ、(Offset+PageSize)>=TotalCount で停止。
 *   - 親子: ユーザ定義 ClassA..Z に親レコード ID を保持 (固定でない) → parentKey をユーザ指定。
 *
 * siteId はユーザ入力 (auth.extra.siteIds)。統一方針: 出力は CsvEntitySource[]。
 */

import { fetchJson, MAX_PAGES, type HttpClientOptions } from './http';
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

const API_VERSION = 1.1;
const PAGE_SIZE = 200;

/** ユーザ定義カラムを格納するハッシュ群。トップレベルに無いキーはここを探す。 */
const HASH_KEYS = ['ClassHash', 'NumHash', 'DateHash', 'CheckHash', 'DescriptionHash'] as const;

// ---------------------------------------------------------------------------
// Pleasanter レスポンス最小型
// ---------------------------------------------------------------------------

export type PleasanterRecord = Record<string, unknown> & {
  ClassHash?: Record<string, unknown>;
  NumHash?: Record<string, unknown>;
  DateHash?: Record<string, unknown>;
  CheckHash?: Record<string, unknown>;
  DescriptionHash?: Record<string, unknown>;
};

interface PleasanterGetResponse {
  StatusCode: number;
  Response?: { Offset: number; PageSize: number; TotalCount: number; Data: PleasanterRecord[] };
}

interface PleasanterSiteResponse {
  StatusCode: number;
  Response?: { ReferenceType?: string; EditorColumnHash?: Record<string, string[]> };
}

// ---------------------------------------------------------------------------
// 純関数: 値抽出 / records → CsvEntitySource
// ---------------------------------------------------------------------------

/**
 * Pleasanter レコードから key の値を取り出す。
 * トップレベル (Title/Body/Status/StartTime 等) → 各 Hash (ClassA/NumA/DateA…) の順で探す。
 */
export function extractPleasanterField(record: PleasanterRecord, key: string): string {
  if (key in record) {
    const v = record[key];
    return v == null ? '' : String(v);
  }
  for (const h of HASH_KEYS) {
    const hash = record[h] as Record<string, unknown> | undefined;
    if (hash && key in hash) {
      const v = hash[key];
      return v == null ? '' : String(v);
    }
  }
  return '';
}

function recordToRow(record: PleasanterRecord, keys: string[]): CsvRow {
  const row: CsvRow = {};
  for (const key of keys) row[key] = extractPleasanterField(record, key);
  return row;
}

function usedKeys(columnMap: Record<string, string>): string[] {
  const set = new Set<string>();
  for (const v of Object.values(columnMap)) if (v) set.add(v);
  return [...set];
}

/** 非WBSエンティティ (Results→課題 等): records → CsvEntitySource。 */
export function pleasanterRecordsToCsvSource(
  records: PleasanterRecord[],
  entity: CsvEntitySource['entity'],
  columnMap: Record<string, string>,
  fixedMap?: Record<string, string>,
): CsvEntitySource {
  const keys = usedKeys(columnMap);
  return { entity, rows: records.map((r) => recordToRow(r, keys)), columnMap, fixedMap };
}

/** WBSエンティティ (Issues): records → レベル列つき CsvEntitySource。 */
export function pleasanterRecordsToWbsSource(
  records: PleasanterRecord[],
  params: { idKey: string; nameKey: string; parentKey?: string; projectName: string; startKey?: string; endKey?: string; effortKey?: string },
): { source: CsvEntitySource; warnings: string[] } {
  const nodes: SourceWbsNode[] = records.map((r) => {
    const id = extractPleasanterField(r, params.idKey);
    const parent = params.parentKey ? extractPleasanterField(r, params.parentKey) : '';
    const effortRaw = params.effortKey ? extractPleasanterField(r, params.effortKey) : '';
    const effort = effortRaw !== '' && Number.isFinite(Number(effortRaw)) ? Number(effortRaw) : null;
    return {
      sourceId: id || extractPleasanterField(r, params.nameKey),
      parentSourceId: parent !== '' ? parent : null,
      name: extractPleasanterField(r, params.nameKey),
      plannedStartDate: params.startKey ? extractPleasanterField(r, params.startKey) || null : null,
      plannedEndDate: params.endKey ? extractPleasanterField(r, params.endKey) || null : null,
      plannedEffort: effort,
    };
  });
  const { rows, warnings } = wbsNodesToCsvRows(nodes, params.projectName);
  return { source: { entity: 'wbs', rows, columnMap: WBS_ROW_COLUMN_MAP }, warnings };
}

// ---------------------------------------------------------------------------
// HTTP: discover / fetch
// ---------------------------------------------------------------------------

function trimBase(baseUrl: string | undefined): string {
  return (baseUrl ?? '').replace(/\/+$/, '');
}

function siteIdsOf(auth: ConnectorAuth): string[] {
  const raw = auth.extra?.siteIds ?? auth.extra?.siteId ?? '';
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/** discover: 指定サイト (auth.extra.siteIds) の ReferenceType + カラムを返す。Wikis は除外。 */
export async function pleasanterDiscover(auth: ConnectorAuth, http: HttpClientOptions = {}): Promise<DiscoveredSchema> {
  const base = trimBase(auth.baseUrl);
  const siteIds = siteIdsOf(auth);
  const warnings: string[] = [];
  if (!base || siteIds.length === 0) {
    return {
      source: 'pleasanter',
      sources: [],
      warnings: ['ベースURL (オンプレ or https://pleasanter.net/fs) とサイト ID を入力してください。'],
    };
  }
  const sources: DiscoveredSource[] = [];
  for (const siteId of siteIds) {
    const res = await fetchJson<PleasanterSiteResponse>(
      { url: `${base}/api/items/${siteId}/getsite`, method: 'POST', body: { ApiVersion: API_VERSION, ApiKey: auth.token } },
      http,
    );
    const refType = res.Response?.ReferenceType;
    if (refType === 'Wikis') {
      warnings.push(`サイト ${siteId} は Wiki のため移行対象外です。`);
      continue;
    }
    const cols = res.Response?.EditorColumnHash?.General ?? [];
    const fields: DiscoveredField[] = cols.map((c) => ({ key: c, label: c, type: 'text' }));
    sources.push({
      id: siteId,
      name: `サイト ${siteId} (${refType ?? '不明'})`,
      fields,
      entityHint: refType === 'Issues' ? 'wbs' : refType === 'Results' ? 'risk' : undefined,
    });
  }
  return { source: 'pleasanter', sources, warnings };
}

/** 1 サイトの全レコードを Offset ページングで取得 (KeyValues 指定で表示名解決)。 */
async function fetchAllRecords(
  base: string,
  token: string,
  siteId: string,
  http: HttpClientOptions,
): Promise<PleasanterRecord[]> {
  const all: PleasanterRecord[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchJson<PleasanterGetResponse>(
      {
        url: `${base}/api/items/${siteId}/get`,
        method: 'POST',
        body: { ApiVersion: API_VERSION, ApiKey: token, Offset: offset, View: { ApiDataType: 'KeyValues' } },
      },
      http,
    );
    const data = res.Response?.Data ?? [];
    const total = res.Response?.TotalCount ?? 0;
    all.push(...data);
    offset += res.Response?.PageSize ?? PAGE_SIZE;
    if (data.length === 0 || all.length >= total) break;
  }
  return all;
}

export async function pleasanterFetchSources(
  auth: ConnectorAuth,
  mapping: ConnectorMapping,
  http: HttpClientOptions = {},
): Promise<{ sources: CsvEntitySource[]; warnings: string[] }> {
  const base = trimBase(auth.baseUrl);
  const out: CsvEntitySource[] = [];
  const warnings: string[] = [];
  for (const m of mapping.mappings) {
    const records = await fetchAllRecords(base, auth.token, m.sourceId, http);
    if (m.entity === 'wbs') {
      const { source, warnings: w } = pleasanterRecordsToWbsSource(records, {
        idKey: m.options?.idKey as string | undefined ?? 'IssueId',
        nameKey: m.columnMap.name ?? 'Title',
        parentKey: m.parentKey,
        projectName: m.fixedMap?.projectName ?? '',
        startKey: m.columnMap.plannedStartDate,
        endKey: m.columnMap.plannedEndDate,
        effortKey: m.columnMap.plannedEffort,
      });
      out.push(source);
      warnings.push(...w);
    } else {
      out.push(pleasanterRecordsToCsvSource(records, m.entity, m.columnMap, m.fixedMap));
    }
  }
  return { sources: out, warnings };
}

export const pleasanterConnector: MigrationConnector = {
  source: 'pleasanter',
  discover: (auth) => pleasanterDiscover(auth),
  fetchSources: async (auth, mapping) => (await pleasanterFetchSources(auth, mapping)).sources,
};
