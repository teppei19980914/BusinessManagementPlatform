/**
 * 検索プロバイダ抽象インターフェース（設計書: DESIGN.md セクション 16.2）
 * 将来の外部サービス移行に対応するため、実装を差し替え可能にする。
 *
 * 2026-05-12 severity-1 防御: 検索結果に他テナントのデータが混入しないよう、
 *   `tenantId` を必須引数化。実装側 (PgTrgmSearchProvider 等) はこの値で
 *   必ず where フィルタを掛けること。将来 Meilisearch 等の外部サービスを
 *   差し替える場合も、インデックス分離 or filter で同等の保証が必要。
 *
 *   旧仕様: tenantId / visibility いずれのフィルタもなく、有効化された場合
 *     即座にクロステナント情報漏洩 + draft 漏洩の重大バグになる脆弱な API
 *     設計だった。本コミットで TS 型レベルで tenantId を必須化し、未指定では
 *     コンパイル不可にする (使用箇所がゼロでも将来活性化時のリスクを構造的に除去)。
 */

export type SearchParams = {
  query: string;
  entityTypes: ('knowledge' | 'project' | 'risk')[];
  /** 検索結果を絞り込む viewer の所属テナント (severity-1 越境防止のため必須)。 */
  tenantId: string;
  /**
   * 検索結果に non-public な entity を含めるか判定するための viewer ID。
   * 省略時は public のみ。指定時は「自分の draft も含む」想定 (実装側で適切に解釈)。
   */
  viewerUserId?: string;
  /**
   * viewer が admin role を持つかどうか。true の場合、自テナント内の draft / private を
   * 全件閲覧可とする (検索結果の認可境界)。デフォルト false。
   */
  viewerIsAdmin?: boolean;
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
