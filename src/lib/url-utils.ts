/**
 * URL 関連ユーティリティ。
 *
 * セキュリティ上重要 (CWE-601 Open Redirect 対策、PR #198 で導入):
 *   ログイン後の callbackUrl リダイレクトに **外部 URL を許可すると phishing 経路** に
 *   悪用される。例: `/login?callbackUrl=https://evil.example.com/login` で攻撃者の
 *   サイトに誘導され、たすきば風 UI で再認証を促されてパスワードを抜かれる。
 *
 *   `isSafeCallbackUrl` で「同一オリジン (= `/` で始まり `//` で始まらない) かつ
 *   `\\` を含まない (Windows パス偽装による外部誘導防止)」を検証してから redirect する。
 */

/**
 * callbackUrl が同一オリジン内のパスとして安全に扱えるかを判定する。
 *
 * 受理:
 *   - `/projects` (絶対パス、最も一般的)
 *   - `/projects/abc?tab=members` (クエリ付き)
 *   - `/projects/abc#section` (フラグメント付き)
 *
 * 拒否:
 *   - `https://evil.com/login` (外部 URL)
 *   - `//evil.com/login` (スキーマ相対 URL = 同一スキーマで外部へ誘導)
 *   - `javascript:alert(1)` (XSS スキーマ)
 *   - `\\evil.com\share` (Windows UNC 風による解釈ずれ)
 *   - 空文字 / null / undefined
 *
 * @param url 検証対象 URL
 * @returns 同一オリジンとして安全なら true、それ以外は false
 */
export function isSafeCallbackUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  // `/` で始まり、`//` で始まらず、`\` を含まないこと
  if (!url.startsWith('/')) return false;
  if (url.startsWith('//')) return false;
  // 後ろに `\` で外部誘導を試みるブラウザ依存挙動を遮断
  if (url.includes('\\')) return false;
  return true;
}

/**
 * `isSafeCallbackUrl` で受理されればそのまま、拒否されれば fallback (既定 `/`) を返す。
 * リダイレクト直前の sanitize layer として使用する。
 *
 * 使用例:
 *   const target = sanitizeCallbackUrl(callbackUrl);
 *   window.location.href = target;
 */
export function sanitizeCallbackUrl(
  url: string | null | undefined,
  fallback: string = '/',
): string {
  return isSafeCallbackUrl(url) ? (url as string) : fallback;
}
