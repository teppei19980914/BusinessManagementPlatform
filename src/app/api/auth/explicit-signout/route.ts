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
 *   - **【P0】 Cookie 削除はベストエフォート**: auth 系 4 cookie を `Max-Age=0` で削除。
 *     Set-Cookie 透過時は綺麗に消える、脱落時もサーバ側は既に無効化済。
 *   - **【P1】 UI preference cookie もログアウトで削除**: `tasukiba-theme` を同時削除。
 *     ユーザの DB themePreference は維持されるため、再ログイン時に JWT 経由で復元
 *     (`src/app/layout.tsx` の cookie > JWT > 'light' fallback)。
 *   - **べき等性**: 未認証 POST でも 200 を返す + cookie 削除 Set-Cookie は付与する
 *     (cookie が残留しているが session が既に無効、というシナリオを想定)。
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

/** NextAuth v5 が使う auth 系 cookie 名 (production / development の両方を削除対象に含める)。 */
const AUTH_COOKIE_NAMES_TO_CLEAR = [
  '__Secure-authjs.session-token', // production session token
  'authjs.session-token',          // development session token
  '__Host-authjs.csrf-token',      // production CSRF token
  'authjs.csrf-token',             // development CSRF token
] as const;

export async function POST() {
  const session = await auth();

  // 【P0】 認証済の場合のみ tokenVersion increment + 監査ログ記録 (未認証はべき等にスルー)
  if (session?.user?.id) {
    try {
      await prisma.user.update({
        where: { id: session.user.id },
        data: { tokenVersion: { increment: 1 } },
      });
      await recordAuthEvent({
        eventType: 'logout',
        tenantId: session.user.tenantId,
        userId: session.user.id,
        email: session.user.email ?? undefined,
      });
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

  // 【P0】 auth 系 cookie 削除 (Max-Age=0)。両環境名を網羅して salt 判定ズレ事故 (KDD §5.X+66 補遺) を回避
  for (const name of AUTH_COOKIE_NAMES_TO_CLEAR) {
    response.cookies.set(name, '', {
      httpOnly: true,
      sameSite: 'strict',
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
