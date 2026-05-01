/**
 * テキスト検索の共通ヘルパ (Phase C 要件 19 / 2026-04-28 で確立)。
 *
 * 仕様:
 *   - 入力 query を空白 (半角/全角 / 連続も可) で分割し、各トークンを評価する
 *   - 含むトークン (positive): OR 条件で fields のいずれかに含まれる
 *     例: 「ログイン エラー」と入力すると「ログイン」または「エラー」を含むレコードがヒット
 *   - 含まないトークン (negative): `-` プレフィックス。すべての fields に含まれていないレコードのみヒット
 *     例: 「-完了」と入力すると「完了」を含まないレコードがヒット
 *   - 含む / 含まない を組み合わせ可能
 *     例: 「重要 -完了」 → 「重要」を含み、「完了」を含まないレコード
 *
 * 検索対象は呼び出し側が複数フィールドを配列で渡す (タイトル + 本文 + 担当者名 等)。
 * 大小文字は区別しない (toLowerCase で正規化)。
 *
 * 旧仕様 (Phase C 以前):
 *   `text.includes(query.toLowerCase())` — query 全体を 1 つの substring としてマッチ。
 *   「ログイン エラー」と入力すると空白を含む文字列を持つレコードしかヒットしない不便があった。
 *
 * 拡張仕様 (PR fix/list-export-and-filter / 2026-05-01):
 *   `-` プレフィックスで否定条件をサポート (Google 検索風)。
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
 * トークンを「含む」(positive) と「含まない」(negative) に分離する。
 *   - `-` で始まり 2 文字以上のトークン → negative (先頭の `-` を取り除く)
 *   - `-` 単独や `-` のみのトークン → 無視 (空文字扱い)
 *   - それ以外 → positive
 */
export function splitPositiveNegativeTokens(query: string): {
  positive: string[];
  negative: string[];
} {
  const tokens = splitKeywordTokens(query);
  const positive: string[] = [];
  const negative: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('-')) {
      const stripped = token.slice(1);
      if (stripped.length > 0) negative.push(stripped);
      // 空 (`-` 単独) は無視
    } else {
      positive.push(token);
    }
  }
  return { positive, negative };
}

/**
 * query を positive (含む) / negative (含まない) に分けて評価する:
 *   - query が空 (もしくは空白のみ) → 全件マッチ
 *   - negative トークンがいずれかの field に含まれる → false (除外)
 *   - positive トークンが 1 つでも field に含まれる → true (OR 条件)
 *   - negative のみで positive 無し → 除外条件のみ評価して残ったもの true
 *
 * 関数名は backward-compat のため保持。Negative 対応の拡張は仕様書冒頭参照。
 */
export function matchesAnyKeyword(
  query: string,
  fields: (string | null | undefined)[],
): boolean {
  const { positive, negative } = splitPositiveNegativeTokens(query);
  if (positive.length === 0 && negative.length === 0) return true;
  const haystack = fields.map((f) => (f ?? '').toLowerCase());
  // negative: いずれかの field に含まれていれば除外
  if (negative.length > 0 && negative.some((token) => haystack.some((text) => text.includes(token)))) {
    return false;
  }
  // positive 無しの場合 (negative-only クエリ) は negative チェックを通過したので true
  if (positive.length === 0) return true;
  // positive: 1 つでもヒットすれば true (OR)
  return positive.some((token) => haystack.some((text) => text.includes(token)));
}
