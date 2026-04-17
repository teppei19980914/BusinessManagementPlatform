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
    maxAge: 24 * 60 * 60,
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
