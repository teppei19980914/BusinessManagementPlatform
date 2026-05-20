/**
 * 認証フロー URL ビルダ (ADR-0016 / 2026-05-20)
 *
 * メール送信 (= 招待 / パスワードリセット) で使用する URL を一元生成する。
 * tenantSlug を含めることで、リンククリック時に pre-auth フローで
 * tenant 識別を確実にする。
 *
 * Option B (= 組織 ID 入力欄方式) 採用:
 *   - URL クエリパラメタ `tenant` で tenant_slug を渡す
 *   - 例: https://tasukiba.netlify.app/setup-password?tenant=acme-corp&token=xxx
 *
 * 将来 Option A (= サブドメイン方式) への移行容易化:
 *   - 本ファイルの各関数の内部実装のみを差し替え (= subdomain URL に変更)
 *   - 例: https://acme-corp.tasukiba.app/setup-password?token=xxx
 *
 * 関連:
 *   - 設計判断: docs/adr/0016-multi-tenant-user-membership.md
 *   - tenant 解決: src/lib/tenant-resolver.ts
 */

/**
 * ログイン URL を生成 (= tenantSlug を含む)。
 */
export function buildLoginUrl(tenantSlug: string, baseUrl: string): string {
  const slug = encodeURIComponent(tenantSlug);
  return `${baseUrl}/login?tenant=${slug}`;
  // ============================================================
  // 将来 Option A 移行時:
  //   const rootDomain = new URL(baseUrl).hostname.replace(/^[^.]+\./, '');
  //   return `https://${slug}.${rootDomain}/login`;
  // ============================================================
}

/**
 * パスワード設定 (= 招待経由の初回 setup) URL を生成。
 */
export function buildSetupPasswordUrl(
  tenantSlug: string,
  token: string,
  baseUrl: string,
): string {
  const slug = encodeURIComponent(tenantSlug);
  const tk = encodeURIComponent(token);
  return `${baseUrl}/setup-password?tenant=${slug}&token=${tk}`;
}

/**
 * パスワードリセット (= 既存ユーザの忘れた) URL を生成。
 */
export function buildResetPasswordUrl(
  tenantSlug: string,
  token: string,
  baseUrl: string,
): string {
  const slug = encodeURIComponent(tenantSlug);
  const tk = encodeURIComponent(token);
  return `${baseUrl}/reset-password?tenant=${slug}&token=${tk}`;
}

/**
 * lock-status 画面 URL を生成。
 */
export function buildLockStatusUrl(tenantSlug: string, baseUrl: string): string {
  const slug = encodeURIComponent(tenantSlug);
  return `${baseUrl}/lock-status?tenant=${slug}`;
}
