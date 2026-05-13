/**
 * NextAuth v5 公式パターン: Edge 互換 middleware
 * auth.config.ts の authorized コールバックで認証チェックを行う。
 * Prisma などの Node.js 依存を含まないため、Edge Runtime で動作する。
 *
 * 2026-05-13 (security/auth-secret-hardening, B-2): Credential stuffing 対策。
 *   NextAuth の Credentials provider POST に IP 単位の rate limit を入れる。
 *   アカウントロック (5 回失敗 → 30 分) は被害者単位の防御で、攻撃者がメールリストを
 *   ばらして低試行回数で広域に試す手口を防げない (1 アカウント 4 回 × 100 万件 = 400 万試行)。
 *   本 IP 単位 rate limit と組み合わせる事で、攻撃者の試行コストを大幅に引き上げる。
 *
 *   Edge runtime + serverless instance 分散により完全な制限ではないが (rate-limit.ts §13-21
 *   設計判断)、攻撃のコストを上げる多層防御の 1 層として機能する。
 *
 * 2026-05-13 (security/auth-secret-hardening, B-2 follow-up):
 *   E2E (Playwright) は CI 上で複数 worker 並列実行され、各 spec が beforeEach で
 *   loginAs() を呼ぶため、同一 IP (localhost) から短時間に大量の login が発生する。
 *   max=20 / 5分 では 21 件目以降が 429 で弾かれ、E2E が失敗する (PR #345 で発覚)。
 *   `DISABLE_LOGIN_RATE_LIMIT='true'` でバイパス可能にし、CI の e2e.yml と
 *   e2e-visual-baseline.yml で明示的に有効化する。
 *
 *   本番 env (Vercel) では当然このフラグを設定しない → rate limit は常時有効。
 *   バイパス可能であることは docs/test/E2E_LESSONS.md に明記して負債化を防ぐ。
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
 *
 * 2026-05-13 (merge: PR #345 ⨯ PR #349 conflict resolution):
 *   login rate limit (B-2) と CSP nonce (L-5) を併存させる構成。
 *   - login POST: rate limit のみチェック (返り値が POST 用、CSP nonce は不要)
 *   - それ以外の全リクエスト: CSP nonce を生成して response header に設定
 *   - 両処理とも NextResponse を return するため、後段の authorized callback の
 *     skip 影響を回避するため `NextResponse.next` を経由する。
 *   詳細: docs/knowledge/KDD_PATTERNS.md §5.X+42
 */

import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { authConfig } from '@/lib/auth.config';
import { applyRateLimit } from '@/lib/rate-limit';

const { auth } = NextAuth(authConfig);

/**
 * login rate limit を完全に無効化する環境変数フラグ。E2E / 負荷試験用。
 * 本番では絶対に設定しないこと (= デフォルト未設定で rate limit 有効)。
 */
const LOGIN_RATE_LIMIT_DISABLED = process.env.DISABLE_LOGIN_RATE_LIMIT === 'true';

/**
 * Content-Security-Policy ヘッダを生成する。
 *
 * 2026-05-13 PR #349 follow-up (graceful degradation):
 *   元実装は production で `script-src 'self' 'nonce-X' 'strict-dynamic'` にして
 *   `unsafe-inline` を完全排除した。しかし Next.js 16 の nonce 自動付与は
 *   inline RSC payload に nonce が付与されないケースがあり、E2E spec 01 Step 4
 *   が production CI で hydration 失敗 (画面が「確認中...」で停止) する症状を起こした。
 *
 *   `strict-dynamic` は CSP 仕様で `self` と `unsafe-inline` を **無効化** する
 *   ため、nonce 付与失敗 = 全 inline script 拒否 = hydration 完全停止という悪い
 *   全壊シナリオを引き起こす。
 *
 *   対策: `strict-dynamic` を外し、`nonce-X` + `unsafe-inline` を併存させる。
 *   - nonce 自動付与が機能する場合: modern browser は nonce based で評価 (= 強い防御)
 *   - nonce 付与失敗時 / 旧 browser: `unsafe-inline` で fallback (= pre-PR と同等の挙動)
 *   xss-reviewer 元評価でも「XSS 一次防御 (危険 API 使用ゼロ) が強固なので CSP は
 *   二次防御として実害なし」と評価済。**「壊さない最強の防御」** を採用 (graceful degradation)。
 *
 *   詳細: docs/knowledge/KDD_PATTERNS.md §5.X+43
 */
function buildCspHeader(nonce: string, isDev: boolean): string {
  // 開発・本番ともに nonce + unsafe-inline 併存。strict-dynamic は使わない。
  // 開発時は HMR / React Refresh のため `unsafe-` 系の動的実行も追加で許可。
  const scriptSrc = isDev
    ? `script-src 'self' 'nonce-${nonce}' 'unsafe-inline' 'unsafe-eval'`
    : `script-src 'self' 'nonce-${nonce}' 'unsafe-inline'`;
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
  // ----------------------------------------------------------------
  // 1. login POST に対する IP 単位レート制限 (B-2 / PR #345)
  // ----------------------------------------------------------------
  if (
    req.nextUrl.pathname === '/api/auth/callback/credentials'
    && req.method === 'POST'
    && !LOGIN_RATE_LIMIT_DISABLED
  ) {
    // max=20 / window=5 分: 通常利用 (1 ユーザが間違って 2-3 回試行 + 同一 NAT 内
    // 数ユーザ) を吸収しつつ、credential stuffing は確実に弾く水準。
    const limited = applyRateLimit(req, { key: 'login', max: 20, windowMs: 5 * 60 * 1000 });
    if (limited) return limited;
    // 通過時は CSP nonce 不要 (login POST レスポンスは NextAuth redirect のみ)。
    // ここで明示的に return undefined すると NextAuth の authorized callback が走る。
    return;
  }

  // ----------------------------------------------------------------
  // 2. それ以外の全リクエスト: CSP nonce 生成 + response header 設定 (L-5 / PR #349)
  // ----------------------------------------------------------------
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
