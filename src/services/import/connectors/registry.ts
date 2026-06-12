/**
 * 外部移行インポート — コネクタ登録レジストリ (ADR-0034)
 *
 * サービス種別 → コネクタ実装 (discover / fetchSources) の対応表。
 * ルート/UI はこのレジストリ経由でコネクタを引き、個別 import を持たない。
 */

import type { CsvEntitySource } from '../csv-to-batch';
import type { ApiImportSource, ConnectorAuth, ConnectorMapping, DiscoveredSchema } from './types';
import { notionDiscover, notionFetchSources } from './notion';
import { backlogDiscover, backlogFetchSources } from './backlog';
import { kintoneDiscover, kintoneFetchSources } from './kintone';
import { pleasanterDiscover, pleasanterFetchSources } from './pleasanter';
import { sheetsDiscover, sheetsFetchSources } from './google-sheets';

export interface ConnectorImpl {
  discover(auth: ConnectorAuth): Promise<DiscoveredSchema>;
  fetchSources(auth: ConnectorAuth, mapping: ConnectorMapping): Promise<{ sources: CsvEntitySource[]; warnings: string[] }>;
}

export const CONNECTORS: Record<ApiImportSource, ConnectorImpl> = {
  notion: { discover: (a) => notionDiscover(a), fetchSources: (a, m) => notionFetchSources(a, m) },
  backlog: { discover: (a) => backlogDiscover(a), fetchSources: (a, m) => backlogFetchSources(a, m) },
  kintone: { discover: (a) => kintoneDiscover(a), fetchSources: (a, m) => kintoneFetchSources(a, m) },
  pleasanter: { discover: (a) => pleasanterDiscover(a), fetchSources: (a, m) => pleasanterFetchSources(a, m) },
  google_sheets: { discover: (a) => sheetsDiscover(a), fetchSources: (a, m) => sheetsFetchSources(a, m) },
};

/** 第1弾の API 連携対応サービス。 */
export const API_IMPORT_SOURCES: ApiImportSource[] = [
  'notion',
  'backlog',
  'kintone',
  'pleasanter',
  'google_sheets',
];

/** サービスの画面表示名。 */
export const API_SOURCE_LABELS: Record<ApiImportSource, string> = {
  notion: 'Notion',
  backlog: 'Backlog',
  kintone: 'kintone',
  pleasanter: 'Pleasanter',
  google_sheets: 'Google スプレッドシート',
};

export function isApiImportSource(v: unknown): v is ApiImportSource {
  return typeof v === 'string' && (API_IMPORT_SOURCES as string[]).includes(v);
}
