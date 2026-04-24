/**
 * NextAuth v5 の Edge 互換設定（middleware 用）
 * Prisma などの Node.js 依存を含まない。
 * middleware.ts からインポートして使用する。
 */

import type { NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import {
  PUBLIC_PATHS,
  MFA_PENDING_PATHS,
  LOGIN_PATH,
  MFA_LOGIN_PATH,
  SESSION_JWT_MAX_AGE_SEC,
} from '@/config';

export const authConfig: NextAuthConfig = {
  providers: [
    // Credentials provider の定義（authorize は auth.ts で上書き）
    Credentials({
      credentials: {
        email: {},
        password: {},
      },
    }),
  ],
  secret: process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET,
  trustHost: true,
  session: {
    strategy: 'jwt',
    // JWT 自体の有効期限 (安全網)。ただしタブ / ブラウザを閉じた時点で
    // セッション cookie が失われるので実質はそれまで。
    maxAge: SESSION_JWT_MAX_AGE_SEC,
  },
  /**
   * セッション cookie 化 (PR #59 Req 4):
   *   既定では NextAuth は maxAge を cookie の expires にも反映し、永続 cookie に
   *   するためブラウザを閉じてもログイン状態が残る。ここで明示的に maxAge を
   *   省いた cookie options を与えることで「ブラウザ/タブを閉じると破棄される」
   *   セッション cookie に切り替える。
   *
   *   name は NextAuth v5 の規約: 本番 (https) では "__Secure-" プレフィックス、
   *   開発 (http) では通常名を使う。
   */
  cookies: {
    sessionToken: {
      name:
        process.env.NODE_ENV === 'production'
          ? '__Secure-authjs.session-token'
          : 'authjs.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        // maxAge を指定しない → セッション cookie (タブ/ブラウザ閉じで失効)
      },
    },
  },
  pages: {
    signIn: LOGIN_PATH,
  },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isPublicPath = PUBLIC_PATHS.some((path) =>
        nextUrl.pathname.startsWith(path),
      );

      if (isPublicPath) return true;

      const isLoggedIn = !!auth?.user;
      if (!isLoggedIn) {
        return Response.redirect(new URL(LOGIN_PATH, nextUrl));
      }

      // PR #67: MFA 有効ユーザが TOTP 未検証で保護領域にアクセスしようとしたら
      // /login/mfa に誘導する。検証フロー中だけ許容するパス群 (MFA_PENDING_PATHS) は
      // 通過させ、MFA 画面自体や verify API を呼べるようにする。
      const mfaPending
        = auth.user.mfaEnabled === true && auth.user.mfaVerified !== true;
      if (mfaPending) {
        const isMfaAllowed = MFA_PENDING_PATHS.some((p) =>
          nextUrl.pathname.startsWith(p),
        );
        if (!isMfaAllowed) {
          return Response.redirect(new URL(MFA_LOGIN_PATH, nextUrl));
        }
      }

      return true;
    },
    jwt({ token, user, trigger, session }) {
      if (user) {
        token.id = user.id;
        token.systemRole = (user as unknown as { systemRole: string }).systemRole;
        token.forcePasswordChange = (user as unknown as { forcePasswordChange: boolean })
          .forcePasswordChange;
        // PR #67: パスワード認証直後は mfaVerified を常に false にリセット。
        // 以前のセッションで検証済みでも、新規ログインでは必ず再検証を要求する。
        token.mfaEnabled = (user as unknown as { mfaEnabled: boolean }).mfaEnabled;
        token.mfaVerified = false;
        // PR #72: テーマ設定も JWT に入れて layout.tsx から参照できるようにする。
        token.themePreference = (user as unknown as { themePreference?: string }).themePreference ?? 'light';
        // PR #118: i18n 設定も JWT に入れて SSR/CSR 共通で TZ/locale 解決できるようにする。
        //   null は「システムデフォルト使用」の意味。描画側で resolveTimezone/resolveLocale を通す。
        token.timezone = (user as unknown as { timezone?: string | null }).timezone ?? null;
        token.locale = (user as unknown as { locale?: string | null }).locale ?? null;
      }
      // PR #67: /login/mfa で useSession().update({ mfaVerified: true }) を
      // 呼ぶと trigger='update' の session 渡しで TOTP 検証済を token に反映する。
      // PR #72: 設定画面でテーマ変更時も同経路で { themePreference: '...' } を反映する。
      // PR #118: 設定画面で TZ / locale を変更時も同じ経路で反映 (null 指定でシステム既定に戻せる)。
      if (trigger === 'update' && session && typeof session === 'object') {
        const patch = session as {
          mfaVerified?: boolean;
          themePreference?: string;
          timezone?: string | null;
          locale?: string | null;
        };
        if (patch.mfaVerified === true) token.mfaVerified = true;
        if (typeof patch.themePreference === 'string') {
          token.themePreference = patch.themePreference;
        }
        // timezone/locale は null を明示して「システム既定に戻す」が可能なので
        // in 演算子でキー存在を確認する。
        if ('timezone' in patch) {
          token.timezone = patch.timezone ?? null;
        }
        if ('locale' in patch) {
          token.locale = patch.locale ?? null;
        }
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.systemRole = token.systemRole as string;
        session.user.forcePasswordChange = token.forcePasswordChange as boolean;
        session.user.mfaEnabled = (token.mfaEnabled as boolean | undefined) ?? false;
        session.user.mfaVerified = (token.mfaVerified as boolean | undefined) ?? false;
        session.user.themePreference = (token.themePreference as string | undefined) ?? 'light';
        // PR #118: null 許容 (システムデフォルト意) のまま公開する。
        session.user.timezone = (token.timezone as string | null | undefined) ?? null;
        session.user.locale = (token.locale as string | null | undefined) ?? null;
      }
      return session;
    },
  },
};
