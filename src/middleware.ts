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
 * 2026-05-13 (security/csp-nonce, L-5) — 取り下げ:
 *   CSP nonce 化を試みたが、Next.js 16 の nonce 自動付与が本サービス環境で
 *   inline RSC payload に nonce を付与できず、production CI で hydration 全壊
 *   (画面が「確認中...」のまま停止) する重大不具合を起こした。
 *   2 段階の修正 (strict-dynamic 除去 / nonce + unsafe-inline 併存) でも改善せず、
 *   CSP 仕様で nonce 指定時は modern browser が unsafe-inline を無視するため
 *   nonce 付与失敗 = 全 block の挙動になることが確定。
 *
 *   方針:
 *   - middleware の CSP nonce 生成ロジックを **完全に削除**
 *   - CSP は next.config.ts の static header (`script-src 'self' 'unsafe-inline'`) に
 *     戻す (= pre-PR #349 状態)
 *   - CSP nonce 化は post-MVP で再挑戦 (Next.js のバージョン更新で改善するか様子見)
 *   詳細: docs/knowledge/KDD_PATTERNS.md §5.X+43 + §5.X+44
 */

import NextAuth from 'next-auth';
import { authConfig } from '@/lib/auth.config';
import { applyRateLimit } from '@/lib/rate-limit';

const { auth } = NextAuth(authConfig);

/**
 * login rate limit を完全に無効化する環境変数フラグ。E2E / 負荷試験用。
 * 本番では絶対に設定しないこと (= デフォルト未設定で rate limit 有効)。
 */
const LOGIN_RATE_LIMIT_DISABLED = process.env.DISABLE_LOGIN_RATE_LIMIT === 'true';

export default auth((req) => {
  // login POST に対する IP 単位レート制限 (B-2 / PR #345)
  if (
    req.nextUrl.pathname === '/api/auth/callback/credentials'
    && req.method === 'POST'
    && !LOGIN_RATE_LIMIT_DISABLED
  ) {
    // max=20 / window=5 分: 通常利用 (1 ユーザが間違って 2-3 回試行 + 同一 NAT 内
    // 数ユーザ) を吸収しつつ、credential stuffing は確実に弾く水準。
    const limited = applyRateLimit(req, { key: 'login', max: 20, windowMs: 5 * 60 * 1000 });
    if (limited) return limited;
  }
  // pass-through: NextAuth の authorized callback に委譲。
});

export const config = {
  // fix/mfa-verify-middleware-cookie-conflict (2026-05-18):
  //   `/api/auth/mfa/verify` を middleware 対象外に追加。
  //   理由: NextAuth v5 の auth() middleware wrapper が `/api/auth/*` 配下に対して
  //   セッションリフレッシュ (旧 JWT 値で Set-Cookie 上書き) を行う場合があり、
  //   本ルートの reissueAuthJwtOnResponse (mfaVerified=true) で書いた cookie が
  //   middleware 側の Set-Cookie で上書きされて mfaVerified=false に戻る事象を実観測。
  //   ルート側で `await auth()` による自前認証チェックを行うため、middleware 除外しても
  //   セキュリティ要件 (本人のみ verify 可) は維持される。
  //   詳細: docs/knowledge/KDD_PATTERNS.md §5.X+69
  //
  // fix/cron-public-paths-and-stripe-disabled-guard (2026-05-18, bundle 修正):
  //   `/api/tenants/me/i18n` も同じ理由で除外。EN→JA への切替時、本ルートが書く
  //   Set-Cookie (新 locale claim) が middleware 側の auto-refresh で旧 locale 値に
  //   上書きされ、UI 反映されない事象を実観測 (PR #401)。本ルートも `getAuthenticatedUser`
  //   + `isTenantAdmin` で自前認証チェック済のため middleware 除外でも認可は維持。
  //   詳細: docs/knowledge/KDD_PATTERNS.md §5.X+71
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/auth/mfa/verify|api/tenants/me/i18n).*)'],
};
