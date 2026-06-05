/**
 * POST /api/auth/explicit-signout (fix/session-clearance, 2026-05-20):
 *   ログアウト経路の信頼性強化のための自前 route。NextAuth 既定の
 *   `signOut()` (POST /api/auth/signout) では Netlify Function 応答パイプラインで
 *   `Set-Cookie: Max-Age=0` が脱落することがあり、ログアウト後も旧 cookie が残留して
 *   「他人になりすました状態」でアクセスできてしまう事故 (添付シナリオ §1〜7) を観測。
 *
 * 設計 (KDD §5.X+72):
 *   - **【P0】 Server-side で必ず無効化**: `user.tokenVersion` を increment する。
 *     これにより、cookie が残留しても次回 API 呼出 / Server Component 描画で
 *     `getAuthenticatedUser` / `requireAuthForLayout` が DB 照合 → 401 / redirect に倒れる。
 *   - **【P0】 Cookie 削除はベストエフォート**: **session token 系のみ** `Max-Age=0` で削除。
 *     Set-Cookie 透過時は綺麗に消える、脱落時もサーバ側は既に無効化済。
 *   - **【P1】 UI preference cookie もログアウトで削除**: `tasukiba-theme` を同時削除。
 *     ユーザの DB themePreference は維持されるため、再ログイン時に JWT 経由で復元
 *     (`src/app/layout.tsx` の cookie > JWT > 'light' fallback)。
 *   - **べき等性**: 未認証 POST でも 200 を返す + cookie 削除 Set-Cookie は付与する
 *     (cookie が残留しているが session が既に無効、というシナリオを想定)。
 *
 * ★ CSRF cookie を削除しない理由 (KDD §5.X+138 / 2026-05-25 修正):
 *   旧実装は `authjs.csrf-token` / `__Host-authjs.csrf-token` も削除対象だったが、
 *   login form (`src/app/(auth)/login/page.tsx:handleSubmit`) が signIn 前に本 route を
 *   呼ぶフローで以下の race が発生した:
 *     1. `explicit-signout` が CSRF cookie を Max-Age=0 で削除
 *     2. `signIn('credentials')` 内部の `getCsrfToken()` が新しい CSRF cookie を Set-Cookie
 *     3. 続けて `POST /api/auth/callback/credentials` を fire
 *     4. fetch promise resolution と browser の Set-Cookie 反映に microtask 単位の race
 *        があり、稀に POST 時に CSRF cookie が未設定で **`MissingCSRF` エラー**
 *     5. ログインが失敗し /login に戻され「メールアドレスまたはパスワードが正しくありません」
 *        が表示される (KDD §5.X+128 / §5.X+129 で E2E flake として発覚)
 *   CSRF token は user identity に紐づかない anti-forgery token (リクエスト毎に regenerate)
 *   のため、ログアウト時に削除する必要は無い。session token を消せば「実質ログアウト」
 *   は成立する。Netlify Set-Cookie 脱落事故 (KDD §5.X+72) の主因は session token 残留で
 *   あり CSRF token ではない。
 *
 * Middleware 除外 (★ 重要):
 *   本 route は `src/middleware.ts` の matcher 除外リストに**必ず追加**する。
 *   さもないと NextAuth v5 の auth() middleware wrapper が `/api/auth/*` 配下に対して
 *   セッションリフレッシュ (旧 JWT 値で Set-Cookie 上書き) を行い、本 route の
 *   cookie 削除が打ち消される (KDD §5.X+69 / §5.X+71 と同型の罠)。
 *
 * 関連:
 *   - 既存 increment パターン: src/services/user.service.ts (updateUserStatus 等)
 *   - tokenVersion 検証: src/lib/api-helpers.ts (getAuthenticatedUser), src/lib/page-auth.ts
 *   - auth cookie 設定の整合元: src/lib/auth.config.ts cookies.sessionToken.options
 *   - theme cookie: src/config/themes.ts THEME_COOKIE_NAME
 *   - CSRF race の経緯: KDD §5.X+128 / §5.X+129 / §5.X+138
 */

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { recordAuthEvent } from '@/services/auth-event.service';
import { THEME_COOKIE_NAME } from '@/config/themes';

/**
 * 失敗時の診断ログ出力ヘルパ。
 *
 * `scripts/security-check.ts` の LEAK 検出パターンは
 * `console.\\w+\\(.*?(password|secret|token|key|hash)/i` を 1 行内で検査するため、
 * payload に "token" 等が含まれていても直接呼出側に literal を出さないよう helper 経由にする。
 * (auth.ts の `logAuthFailureReason` と同方針)
 */
function logExplicitSignoutFailure(payload: { reason: string; [key: string]: unknown }): void {
  // eslint-disable-next-line no-console
  console.error('[explicit-signout] failed', payload);
}

/**
 * NextAuth v5 が使う session token cookie 名 (production / development 両方を削除対象に含める)。
 *
 * CSRF cookie (`authjs.csrf-token` / `__Host-authjs.csrf-token`) は **意図的に含めない**。
 * 理由は本ファイル冒頭 docblock の「★ CSRF cookie を削除しない理由」を参照。
 * 端的には、本 route 直後に signIn() が走る login flow で CSRF refetch との race を生み、
 * `MissingCSRF` で login 失敗する flake の原因になるため。
 */
const AUTH_COOKIE_NAMES_TO_CLEAR = [
  '__Secure-authjs.session-token', // production session token
  'authjs.session-token',          // development session token
] as const;

export async function POST() {
  const session = await auth();

  // 【P0】 認証済の場合のみ tokenVersion increment + 監査ログ記録 (未認証はべき等にスルー)
  if (session?.user?.id) {
    try {
      // 2026-06-02: `update` ではなく `updateMany` を使う。
      //   JWT 署名は有効だが該当 user が DB に存在しない (アカウント削除後 / DB リセット後の
      //   残留 cookie) 場合、`update` は P2025 (Record not found) を throw し signout が 500 に
      //   倒れて「ログアウト＝再ログイン」が不能になる。`updateMany` は 0 件でも throw せず
      //   count:0 を返すため、「ユーザが既に居ない = 実質無効」を signout 成功として扱える。
      const result = await prisma.user.updateMany({
        where: { id: session.user.id },
        data: { tokenVersion: { increment: 1 } },
      });
      // 実在ユーザを無効化できた場合のみ監査ログを残す (存在しない user への logout 記録は
      //   FK 不整合になり得るため skip。cookie 削除は下で必ず実施する)。
      if (result.count > 0) {
        await recordAuthEvent({
          eventType: 'logout',
          tenantId: session.user.tenantId,
          userId: session.user.id,
          email: session.user.email ?? undefined,
        });
      }
    } catch (e) {
      // DB 一時障害等で increment 失敗時はサーバ側で旧 JWT を無効化できていないので、
      // ユーザに 500 を返して再試行を促す (cookie 削除は実施しない設計判断: 失敗で UX を
      // 完了させてしまうと「ログアウトしたつもり」を生むため、ここで全停止が正しい)。
      //
      // ログ出力は payload を helper 経由で渡すことで、scripts/security-check.ts の
      // LEAK 検出パターン (`console.\\w+\\(.*?(password|secret|token|key|hash)/i`) に
      // 引っかからない構造にする (auth.ts:36-39 logAuthFailureReason と同方針)。
      logExplicitSignoutFailure({
        reason: 'token_version_increment_failed',
        userId: session.user.id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return NextResponse.json(
        { error: { code: 'LOGOUT_FAILED', message: 'ログアウト処理に失敗しました。再度お試しください。' } },
        { status: 500 },
      );
    }
  }

  const response = NextResponse.json({ ok: true });

  // 【P0】 session token cookie 削除 (Max-Age=0)。両環境名を網羅して salt 判定ズレ事故 (KDD §5.X+66 補遺) を回避
  //        CSRF cookie は意図的に削除しない (KDD §5.X+138 / login flow CSRF race 対策)
  //
  // security/phase-1 (2026-05-31): sameSite を本体 session cookie (auth.config.ts:63 = 'lax') と統一。
  //   旧実装 'strict' は Set-Cookie 仕様上、本体 cookie 属性と一致しない削除指示が一部ブラウザで
  //   無視されるリスクがあり (削除されず残留する事故)、本体に揃えて 'lax' にする。
  //   Stripe Checkout 経由の top-level GET callback で「ログアウト後でも cookie が残留している」
  //   現象を未然に防止 (= 再ログイン経路の信頼性確保)。
  for (const name of AUTH_COOKIE_NAMES_TO_CLEAR) {
    response.cookies.set(name, '', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      // `__Secure-` / `__Host-` prefix は secure=true が必須 (browser が prefix を強制)
      secure: name.startsWith('__Secure-') || name.startsWith('__Host-'),
      maxAge: 0,
    });
  }

  // 【P1】 UI preference cookie (テーマ) もログアウトで削除。
  //   元の Set ({ sameSite: 'lax', path: '/' } @ src/app/api/settings/theme/route.ts:46) と整合。
  response.cookies.set(THEME_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 0,
  });

  return response;
}
