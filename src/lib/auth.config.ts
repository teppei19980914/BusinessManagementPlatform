/**
 * NextAuth v5 の Edge 互換設定（middleware 用）
 * Prisma などの Node.js 依存を含まない。
 * middleware.ts からインポートして使用する。
 */

import type { NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';

const publicPaths = [
  '/login',
  '/reset-password',
  '/setup-password',
  '/api/auth',
  '/api/health', // ヘルスチェック/ウォームアップ。外部 cron から定期 ping されるため認証不要
];

/**
 * PR #67: MFA 検証フロー中だけアクセスを許可するパス。
 * /login/mfa ページ本体と、TOTP 検証 API を許可する。
 * このパス群はセッションは必要だが mfaVerified が false でもアクセス可能。
 */
const mfaPendingPaths = [
  '/login/mfa',
  '/api/auth/mfa/verify',
  '/api/auth/signout', // 検証中にログアウトできるように
];

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
    // JWT 自体の有効期限 (安全網): 24 時間
    // ただしタブ / ブラウザを閉じた時点でセッション cookie が失われるので実質それまで
    maxAge: 24 * 60 * 60,
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
    signIn: '/login',
  },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isPublicPath = publicPaths.some((path) =>
        nextUrl.pathname.startsWith(path),
      );

      if (isPublicPath) return true;

      const isLoggedIn = !!auth?.user;
      if (!isLoggedIn) {
        return Response.redirect(new URL('/login', nextUrl));
      }

      // PR #67: MFA 有効ユーザが TOTP 未検証で保護領域にアクセスしようとしたら
      // /login/mfa に誘導する。検証フロー中だけ許容するパス群 (mfaPendingPaths) は
      // 通過させ、MFA 画面自体や verify API を呼べるようにする。
      const mfaPending
        = auth.user.mfaEnabled === true && auth.user.mfaVerified !== true;
      if (mfaPending) {
        const isMfaAllowed = mfaPendingPaths.some((p) =>
          nextUrl.pathname.startsWith(p),
        );
        if (!isMfaAllowed) {
          return Response.redirect(new URL('/login/mfa', nextUrl));
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
      }
      // PR #67: /login/mfa で useSession().update({ mfaVerified: true }) を
      // 呼ぶと trigger='update' の session 渡しで TOTP 検証済を token に反映する。
      if (trigger === 'update' && session && typeof session === 'object') {
        const patch = session as { mfaVerified?: boolean };
        if (patch.mfaVerified === true) token.mfaVerified = true;
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
      }
      return session;
    },
  },
};
