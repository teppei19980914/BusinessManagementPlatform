import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { compare } from 'bcryptjs';
import { prisma } from '@/lib/db';

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: {},
        password: {},
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const email = credentials.email as string;
        const password = credentials.password as string;

        const user = await prisma.user.findFirst({
          where: { email, deletedAt: null },
        });

        if (!user) return null;

        // アカウント有効性チェック
        if (!user.isActive) return null;

        // 恒久ロックチェック
        if (user.permanentLock) return null;

        // 一時ロックチェック
        if (user.lockedUntil && user.lockedUntil > new Date()) return null;

        // パスワード照合
        const isValid = await compare(password, user.passwordHash);

        if (!isValid) {
          // ログイン失敗: カウントをインクリメント
          const newCount = user.failedLoginCount + 1;
          const updateData: Record<string, unknown> = {
            failedLoginCount: newCount,
          };

          // 10分以内に5回失敗で一時ロック
          if (newCount >= 5) {
            updateData.lockedUntil = new Date(Date.now() + 30 * 60 * 1000); // 30分
            updateData.failedLoginCount = 0;
          }

          await prisma.user.update({
            where: { id: user.id },
            data: updateData,
          });

          return null;
        }

        // ログイン成功: カウントリセット + 最終ログイン日時更新
        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginCount: 0,
            lockedUntil: null,
            lastLoginAt: new Date(),
          },
        });

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          systemRole: user.systemRole,
          forcePasswordChange: user.forcePasswordChange,
        };
      },
    }),
  ],
  session: {
    strategy: 'jwt',
    maxAge: 24 * 60 * 60, // 24時間
  },
  pages: {
    signIn: '/login',
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.systemRole = (user as unknown as { systemRole: string }).systemRole;
        token.forcePasswordChange = (user as unknown as { forcePasswordChange: boolean })
          .forcePasswordChange;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.systemRole = token.systemRole as string;
        session.user.forcePasswordChange = token.forcePasswordChange as boolean;
      }
      return session;
    },
  },
});
