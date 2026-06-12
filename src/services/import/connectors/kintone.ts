/**
 * 外部移行インポート — kintone (サイボウズ) コネクタ (ADR-0034 / IMPORT_CONNECTORS.md §3)
 *
 * 公式: kintone.dev / ベース https://{subdomain}.kintone.com (or .cybozu.com)
 *
 * 現行仕様の要点:
 *   - 認証: API トークン (アプリ単位・閲覧のみ)。`X-Cybozu-API-Token` ヘッダ。横断参照はカンマ連結。
 *     発行後「アプリ更新 (運用環境反映)」が必須。
 *   - スキーマ: GET /k/v1/app/form/fields.json?app= (型・label・options)。
 *   - 全件取得: カーソル API (POST /k/v1/records/cursor.json size≤500 → GET で next=false まで)。
 *     1 ドメイン同時 10 個・10 分失効・同時不可 → アプリ逐次。
 *   - 型: NUMBER/DATE は文字列、USER_SELECT 等は [{code,name}]、SUBTABLE は配列、
 *     REFERENCE_TABLE は GET で値が返らない (除外)。
 *
 * ベースURL・appId はユーザ入力 (auth.baseUrl / auth.extra.appIds)。推測しない。
 * 統一方針: 出力は CsvEntitySource[]。WBS は parentKey (LOOKUP 等) 指定時のみ階層化、
 * 未指定は全フラット (= 全件 level 1 = ルート ACT)。
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

const CURSOR_SIZE = 500;

// ---------------------------------------------------------------------------
// kintone レスポンス最小型
// ---------------------------------------------------------------------------

export interface KintoneFieldValue {
  type: string;
  value: unknown;
}
/** レコード = フィールドコード → 値。$id / $revision を含む。 */
export type KintoneRecord = Record<string, KintoneFieldValue>;

interface KintoneFormFields {
  properties: Record<string, { code: string; label: string; type: string }>;
}

// ---------------------------------------------------------------------------
// 純関数: 値抽出 / records → CsvEntitySource
// ---------------------------------------------------------------------------

/**
 * kintone フィールド値 → 文字列。配列系は連結、ユーザ系は name、取得不能型は空。
 * 取り込み先で value-mapping / date-normalize が処理するため素の表示文字列に揃える。
 */
export function extractKintoneValue(field: KintoneFieldValue | undefined | null): string {
  if (!field) return '';
  const { type, value } = field;
  switch (type) {
    case 'CHECK_BOX':
    case 'MULTI_SELECT':
    case 'CATEGORY':
      return Array.isArray(value) ? (value as unknown[]).map((v) => String(v)).join(', ') : '';
    case 'USER_SELECT':
    case 'ORGANIZATION_SELECT':
    case 'GROUP_SELECT':
    case 'STATUS_ASSIGNEE':
      return Array.isArray(value)
        ? (value as { code?: string; name?: string }[]).map((v) => v?.name ?? v?.code ?? '').join(', ')
        : '';
    case 'CREATOR':
    case 'MODIFIER':
      return (value as { name?: string; code?: string } | null)?.name ?? '';
    case 'SUBTABLE':
    case 'FILE':
    case 'REFERENCE_TABLE': // GET で値が返らない / 複雑型は除外
      return '';
    default:
      return value == null ? '' : String(value);
  }
}

/** レコードの $id (システム識別子)。階層・ソースキーに使う。 */
function recordId(record: KintoneRecord): string {
  const idField = record['$id'];
  return idField ? String(idField.value) : '';
}

function recordToRow(record: KintoneRecord, fieldCodes: string[]): CsvRow {
  const row: CsvRow = {};
  for (const code of fieldCodes) {
    row[code] = extractKintoneValue(record[code]);
  }
  return row;
}

function usedCodes(columnMap: Record<string, string>, extra: (string | undefined)[] = []): string[] {
  const set = new Set<string>();
  for (const v of Object.values(columnMap)) if (v) set.add(v);
  for (const e of extra) if (e) set.add(e);
  return [...set];
}

/** 非WBSエンティティ: records → CsvEntitySource (1 レコード = 1 行)。 */
export function kintoneRecordsToCsvSource(
  records: KintoneRecord[],
  entity: CsvEntitySource['entity'],
  columnMap: Record<string, string>,
  fixedMap?: Record<string, string>,
): CsvEntitySource {
  const codes = usedCodes(columnMap);
  return { entity, rows: records.map((r) => recordToRow(r, codes)), columnMap, fixedMap };
}

/**
 * WBSエンティティ: records → レベル列つき CsvEntitySource。
 * parentKey 指定時はその値 (親の $id 等) で親子グラフを組む。未指定は全フラット (全 level 1)。
 */
export function kintoneRecordsToWbsSource(
  records: KintoneRecord[],
  params: { nameKey: string; parentKey?: string; projectName: string; startKey?: string; endKey?: string; effortKey?: string },
): { source: CsvEntitySource; warnings: string[] } {
  const nodes: SourceWbsNode[] = records.map((r) => {
    const parent = params.parentKey ? extractKintoneValue(r[params.parentKey]) : '';
    const effortRaw = params.effortKey ? extractKintoneValue(r[params.effortKey]) : '';
    const effort = effortRaw !== '' && Number.isFinite(Number(effortRaw)) ? Number(effortRaw) : null;
    return {
      sourceId: recordId(r) || extractKintoneValue(r[params.nameKey]),
      parentSourceId: parent !== '' ? parent : null,
      name: extractKintoneValue(r[params.nameKey]),
      plannedStartDate: params.startKey ? extractKintoneValue(r[params.startKey]) || null : null,
      plannedEndDate: params.endKey ? extractKintoneValue(r[params.endKey]) || null : null,
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

function kintoneHeaders(token: string): Record<string, string> {
  return { 'X-Cybozu-API-Token': token };
}

function appIdsOf(auth: ConnectorAuth): string[] {
  const raw = auth.extra?.appIds ?? auth.extra?.appId ?? '';
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/** discover: 指定アプリ (auth.extra.appIds) のフィールド定義を返す。 */
export async function kintoneDiscover(auth: ConnectorAuth, http: HttpClientOptions = {}): Promise<DiscoveredSchema> {
  const base = trimBase(auth.baseUrl);
  const appIds = appIdsOf(auth);
  const warnings: string[] = [];
  if (!base || appIds.length === 0) {
    return {
      source: 'kintone',
      sources: [],
      warnings: ['サブドメインURL (例: https://xxx.kintone.com) とアプリ ID を入力してください。'],
    };
  }
  const sources: DiscoveredSource[] = [];
  for (const appId of appIds) {
    const form = await fetchJson<KintoneFormFields>(
      { url: `${base}/k/v1/app/form/fields.json`, query: { app: appId }, headers: kintoneHeaders(auth.token) },
      http,
    );
    const fields: DiscoveredField[] = Object.values(form.properties)
      .filter((p) => p.type !== 'REFERENCE_TABLE') // 値が返らないため候補から除外
      .map((p) => ({ key: p.code, label: p.label, type: p.type }));
    sources.push({ id: appId, name: `アプリ ${appId}`, fields });
  }
  return { source: 'kintone', sources, warnings };
}

interface KintoneCursorCreated {
  id: string;
  totalCount: string;
}
interface KintoneCursorPage {
  records: KintoneRecord[];
  next: boolean;
}

/** カーソル API で 1 アプリの全レコードを取得 (size=500・next=false まで逐次)。 */
async function fetchAllRecords(
  base: string,
  token: string,
  appId: string,
  http: HttpClientOptions,
): Promise<KintoneRecord[]> {
  const headers = kintoneHeaders(token);
  const cursor = await fetchJson<KintoneCursorCreated>(
    { url: `${base}/k/v1/records/cursor.json`, method: 'POST', headers, body: { app: appId, size: CURSOR_SIZE } },
    http,
  );
  const all: KintoneRecord[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchJson<KintoneCursorPage>(
      { url: `${base}/k/v1/records/cursor.json`, query: { id: cursor.id }, headers },
      http,
    );
    all.push(...res.records);
    if (!res.next) break;
  }
  return all;
}

export async function kintoneFetchSources(
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
      const { source, warnings: w } = kintoneRecordsToWbsSource(records, {
        nameKey: m.columnMap.name ?? '',
        parentKey: m.parentKey,
        projectName: m.fixedMap?.projectName ?? '',
        startKey: m.columnMap.plannedStartDate,
        endKey: m.columnMap.plannedEndDate,
        effortKey: m.columnMap.plannedEffort,
      });
      out.push(source);
      warnings.push(...w);
    } else {
      out.push(kintoneRecordsToCsvSource(records, m.entity, m.columnMap, m.fixedMap));
    }
  }
  return { sources: out, warnings };
}

export const kintoneConnector: MigrationConnector = {
  source: 'kintone',
  discover: (auth) => kintoneDiscover(auth),
  fetchSources: async (auth, mapping) => (await kintoneFetchSources(auth, mapping)).sources,
};
