/**
 * テキスト検索の共通ヘルパ (Phase C 要件 19 / 2026-04-28 で確立)。
 *
 * 仕様:
 *   - 入力 query を空白 (半角/全角 / 連続も可) で分割し、各トークンを OR 条件で検索する。
 *     例: 「ログイン エラー」と入力すると「ログイン」または「エラー」を含むレコードがヒット。
 *   - 検索対象は呼び出し側が複数フィールドを配列で渡す (タイトル + 本文 + 担当者名 等)。
 *   - 大小文字は区別しない (toLowerCase で正規化)。
 *
 * 旧仕様 (Phase C 以前):
 *   `text.includes(query.toLowerCase())` — query 全体を 1 つの substring としてマッチ。
 *   「ログイン エラー」と入力すると空白を含む文字列を持つレコードしかヒットしない不便があった。
 */

const TOKEN_SPLIT = /[\s　]+/;

export function splitKeywordTokens(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((t) => t.length > 0);
}

/**
 * query が空 (もしくは空白のみ) なら true (= 全件マッチ扱い、フィルタ非適用)。
 * 1 つでもトークンを含めば fields のいずれかに含まれていれば true (OR 条件)。
 */
export function matchesAnyKeyword(
  query: string,
  fields: (string | null | undefined)[],
): boolean {
  const tokens = splitKeywordTokens(query);
  if (tokens.length === 0) return true;
  const haystack = fields.map((f) => (f ?? '').toLowerCase());
  return tokens.some((token) => haystack.some((text) => text.includes(token)));
}
