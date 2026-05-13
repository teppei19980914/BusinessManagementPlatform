/**
 * NextAuth v5 公式パターン: Edge 互換 middleware
 * auth.config.ts の authorized コールバックで認証チェックを行う。
 * Prisma などの Node.js 依存を含まないため、Edge Runtime で動作する。
 *
 * 2026-05-13 (security/csp-nonce, L-5): CSP nonce 化。
 *   旧実装は next.config.ts の static headers で `script-src 'self' 'unsafe-inline'` を
 *   設定していた (二次防御として実害ないが、agent xss-reviewer S2-1 指摘どおり
 *   reflected XSS が混入した場合の防御深さ不足)。
 *   本実装で middleware からリクエストごとに base64 nonce を生成し、
 *   `script-src 'self' 'nonce-X' 'strict-dynamic'` に変更。Next.js 16 が自動で
 *   `<script nonce={X}>` を生成する (RSC + Server Component 対応)。
 *
 *   公式ドキュメント: https://nextjs.org/docs/app/guides/content-security-policy
 *
 *   実装メモ:
 *   - style-src は 'unsafe-inline' のまま維持 (Tailwind の動的 style class に必要、
 *     nonce 化すると本サービス UI が壊れる)。script-src の 'unsafe-inline' 化だけが
 *     主要な攻撃面なので、優先度として正しい。
 *   - next.config.ts の CSP は middleware が上書き。他のセキュリティヘッダ
 *     (X-Frame-Options / HSTS / Referrer-Policy 等) は next.config.ts 側で
 *     継続管理 (リクエスト独立、設定の分離保守性のため)。
 *   - prefetch 等の Next.js 内部スクリプトも nonce で許可される (strict-dynamic 経由)。
 */

import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { authConfig } from '@/lib/auth.config';

const { auth } = NextAuth(authConfig);

/**
 * Content-Security-Policy ヘッダを生成する。
 * `'unsafe-inline'` を script-src から排除し、nonce + strict-dynamic で固定。
 *
 * 本番 (production) のみ厳格。開発時は HMR / React Refresh の inline script を
 * 通すため緩める ('unsafe-eval' + 'unsafe-inline')。
 */
function buildCspHeader(nonce: string, isDev: boolean): string {
  const scriptSrc = isDev
    ? `script-src 'self' 'nonce-${nonce}' 'unsafe-inline' 'unsafe-eval'`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;
  // style は Tailwind 動的 class のため 'unsafe-inline' 維持 (本サービスの実用性優先)
  const styleSrc = "style-src 'self' 'unsafe-inline'";
  return [
    "default-src 'self'",
    scriptSrc,
    styleSrc,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join('; ');
}

/**
 * Edge 環境互換の base64 ランダム nonce 生成。
 * crypto.randomUUID() の 16 byte UUID を base64 化 → 22 文字程度。
 * リクエストごとに新規生成され、レスポンス header と RSC スクリプトに刻まれる。
 */
function generateNonce(): string {
  const uuid = crypto.randomUUID();
  // Edge runtime に Buffer はあるが、Web 標準の btoa の方が互換性高い。
  return btoa(uuid).replace(/=+$/, '');
}

export default auth((req: NextRequest) => {
  const nonce = generateNonce();
  const isDev = process.env.NODE_ENV === 'development';
  const csp = buildCspHeader(nonce, isDev);

  // x-nonce request header を埋めて Next.js の自動 <script nonce> 生成に渡す
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  // (公式手法) リクエスト header にも CSP を入れることで RSC が値を参照可能
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  // レスポンス header にも同じ CSP を設定 (ブラウザが評価する側)
  response.headers.set('content-security-policy', csp);
  return response;
});

export const config = {
  matcher: [
    /*
     * 静的アセット / 画像最適化 / favicon は除外。
     * next/static の prefetch は nonce 不要 (= CSP の object/script-src で許可される範囲)。
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
