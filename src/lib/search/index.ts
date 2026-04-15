import type { SearchProvider } from './search-provider';
import { PgTrgmSearchProvider } from './pg-trgm-provider';

export type { SearchProvider, SearchParams, SearchResult } from './search-provider';

export function createSearchProvider(): SearchProvider {
  // 環境変数で切替可能（設計書: DESIGN.md セクション 16.2）
  // 将来: case 'meilisearch': return new MeilisearchProvider();
  return new PgTrgmSearchProvider();
}
