/**
 * 検索プロバイダ抽象インターフェース（設計書: DESIGN.md セクション 16.2）
 * 将来の外部サービス移行に対応するため、実装を差し替え可能にする。
 */

export type SearchParams = {
  query: string;
  entityTypes: ('knowledge' | 'project' | 'risk')[];
  filters?: Record<string, string>;
  limit: number;
  offset: number;
};

export type SearchResult = {
  entityType: string;
  entityId: string;
  title: string;
  snippet: string;
  score: number;
};

export interface SearchProvider {
  search(params: SearchParams): Promise<SearchResult[]>;
}
