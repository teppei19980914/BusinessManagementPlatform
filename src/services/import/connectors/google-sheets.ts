/**
 * 外部移行インポート — Google スプレッドシート コネクタ (ADR-0034 / IMPORT_CONNECTORS.md §5)
 *
 * 公式: developers.google.com/workspace/sheets / API v4
 *
 * 現行仕様の要点:
 *   - 認証: 最小権限 spreadsheets.readonly (Bearer)。公開シートは API キー (?key=) でも可。
 *   - 取得: GET /v4/spreadsheets/{id}/values/{range} (A1記法, majorDimension=ROWS)。range 一括 (ページングなし)。
 *   - タブ列挙: GET /v4/spreadsheets/{id}?fields=sheets.properties.title。
 *   - 空セルは省略され行長が不揃い → ヘッダ列数に右パディング。FORMATTED_VALUE 既定で表示文字列。
 *
 * spreadsheetId はユーザ入力 (auth.extra.spreadsheetId)。
 * values は CSV パース結果と同型のため、WBS も「レベル列」方式で既存CSV経路にそのまま流せる
 * (= 親子グラフ変換は不要。1 シート = 1 エンティティ)。
 *
 * Excel(.xlsx) はサーバ側でパースせず、ユーザに「CSV(UTF-8)エクスポート」を案内し既存CSV経路を使う
 * (SheetJS の既知 High 脆弱性回避。攻撃面ゼロ)。本コネクタは Sheets のみ扱う。
 */

import { fetchJson, type HttpClientOptions } from './http';
import type { CsvEntitySource, CsvRow } from '../csv-to-batch';
import type {
  ConnectorAuth,
  ConnectorMapping,
  DiscoveredField,
  DiscoveredSchema,
  DiscoveredSource,
  MigrationConnector,
} from './types';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4';

// ---------------------------------------------------------------------------
// 純関数: values (2次元配列) → CsvEntitySource
// ---------------------------------------------------------------------------

/**
 * Sheets の values (行×列の文字列) → CsvEntitySource。
 * values[0] = ヘッダ、values[1..] = データ。空セルで行が短いものはヘッダ列数に右パディング。
 * columnMap は「たすきばfield → ヘッダ名」(= 既存CSV経路の columnMap と同義)。
 */
export function sheetValuesToCsvSource(
  values: string[][] | undefined,
  entity: CsvEntitySource['entity'],
  columnMap: Record<string, string>,
  fixedMap?: Record<string, string>,
): CsvEntitySource {
  const header = (values?.[0] ?? []).map((h) => String(h ?? '').trim());
  const rows: CsvRow[] = (values ?? []).slice(1).map((r) => {
    const row: CsvRow = {};
    header.forEach((h, i) => {
      if (h === '') return; // 空ヘッダ列は無視
      row[h] = r[i] != null ? String(r[i]) : ''; // 右パディング (短い行)
    });
    return row;
  });
  return { entity, rows, columnMap, fixedMap };
}

/** ヘッダ行 → 列候補 (DiscoveredField)。 */
export function headerToFields(header: string[] | undefined): DiscoveredField[] {
  return (header ?? [])
    .map((h) => String(h ?? '').trim())
    .filter((h) => h !== '')
    .map((h) => ({ key: h, label: h, type: 'text' }));
}

// ---------------------------------------------------------------------------
// HTTP: discover / fetch
// ---------------------------------------------------------------------------

function authParts(auth: ConnectorAuth): { headers: Record<string, string>; key?: string } {
  const apiKey = auth.extra?.apiKey;
  if (apiKey) return { headers: {}, key: apiKey }; // 公開シート: API キー
  return { headers: { Authorization: `Bearer ${auth.token}` } }; // OAuth readonly
}

function spreadsheetId(auth: ConnectorAuth): string {
  return (auth.extra?.spreadsheetId ?? '').trim();
}

interface SheetsMeta {
  sheets?: { properties?: { title?: string } }[];
}
interface SheetsValues {
  values?: string[][];
}

/** discover: タブ (シート) を列挙し、各タブのヘッダ行を列候補にする。 */
export async function sheetsDiscover(auth: ConnectorAuth, http: HttpClientOptions = {}): Promise<DiscoveredSchema> {
  const id = spreadsheetId(auth);
  const { headers, key } = authParts(auth);
  if (!id) {
    return { source: 'google_sheets', sources: [], warnings: ['スプレッドシート ID を入力してください。'] };
  }
  const meta = await fetchJson<SheetsMeta>(
    { url: `${SHEETS_BASE}/spreadsheets/${id}`, query: { fields: 'sheets.properties.title', key }, headers },
    http,
  );
  const titles = (meta.sheets ?? []).map((s) => s.properties?.title ?? '').filter((t) => t !== '');
  const sources: DiscoveredSource[] = [];
  for (const title of titles) {
    const res = await fetchJson<SheetsValues>(
      { url: `${SHEETS_BASE}/spreadsheets/${id}/values/${encodeURIComponent(`${title}!1:1`)}`, query: { key }, headers },
      http,
    );
    sources.push({ id: title, name: title, fields: headerToFields(res.values?.[0]) });
  }
  return { source: 'google_sheets', sources, warnings: [] };
}

/** fetchSources: 各タブの全 values を取得して CsvEntitySource[] に。 */
export async function sheetsFetchSources(
  auth: ConnectorAuth,
  mapping: ConnectorMapping,
  http: HttpClientOptions = {},
): Promise<{ sources: CsvEntitySource[]; warnings: string[] }> {
  const id = spreadsheetId(auth);
  const { headers, key } = authParts(auth);
  const out: CsvEntitySource[] = [];
  for (const m of mapping.mappings) {
    const res = await fetchJson<SheetsValues>(
      { url: `${SHEETS_BASE}/spreadsheets/${id}/values/${encodeURIComponent(m.sourceId)}`, query: { key, majorDimension: 'ROWS' }, headers },
      http,
    );
    out.push(sheetValuesToCsvSource(res.values, m.entity, m.columnMap, m.fixedMap));
  }
  return { sources: out, warnings: [] };
}

export const googleSheetsConnector: MigrationConnector = {
  source: 'google_sheets',
  discover: (auth) => sheetsDiscover(auth),
  fetchSources: async (auth, mapping) => (await sheetsFetchSources(auth, mapping)).sources,
};
