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

      return true;
    },
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.systemRole = (user as unknown as { systemRole: string }).systemRole;
        token.forcePasswordChange = (user as unknown as { forcePasswordChange: boolean })
          .forcePasswordChange;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.systemRole = token.systemRole as string;
        session.user.forcePasswordChange = token.forcePasswordChange as boolean;
      }
      return session;
    },
  },
};
