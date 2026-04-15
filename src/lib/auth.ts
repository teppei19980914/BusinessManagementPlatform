import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { compare } from 'bcryptjs';
import { prisma } from '@/lib/db';
import { recordAuthEvent } from '@/services/auth-event.service';

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

        if (!user) {
          await recordAuthEvent({ eventType: 'login_failure', email, detail: { reason: 'user_not_found' } });
          return null;
        }

        if (!user.isActive) {
          await recordAuthEvent({ eventType: 'login_failure', userId: user.id, email, detail: { reason: 'inactive' } });
          return null;
        }

        if (user.permanentLock) {
          await recordAuthEvent({ eventType: 'login_failure', userId: user.id, email, detail: { reason: 'permanent_lock' } });
          return null;
        }

        if (user.lockedUntil && user.lockedUntil > new Date()) {
          await recordAuthEvent({ eventType: 'login_failure', userId: user.id, email, detail: { reason: 'temporary_lock' } });
          return null;
        }

        const isValid = await compare(password, user.passwordHash);

        if (!isValid) {
          const newCount = user.failedLoginCount + 1;
          const updateData: Record<string, unknown> = {
            failedLoginCount: newCount,
          };

          if (newCount >= 5) {
            updateData.lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
            updateData.failedLoginCount = 0;
            await recordAuthEvent({ eventType: 'lock', userId: user.id, email, detail: { lockType: 'temporary' } });
          }

          await prisma.user.update({
            where: { id: user.id },
            data: updateData,
          });

          await recordAuthEvent({ eventType: 'login_failure', userId: user.id, email, detail: { reason: 'invalid_password' } });
          return null;
        }

        // ログイン成功
        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginCount: 0,
            lockedUntil: null,
            lastLoginAt: new Date(),
          },
        });

        await recordAuthEvent({ eventType: 'login_success', userId: user.id, email });

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
    maxAge: 24 * 60 * 60,
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
