import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { compare } from 'bcryptjs';
import { prisma } from '@/lib/db';
import { recordAuthEvent } from '@/services/auth-event.service';
import { authConfig } from './auth.config';
import { LOGIN_FAILURE_MAX, TEMPORARY_LOCK_DURATION_MS } from '@/config';

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
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

          if (newCount >= LOGIN_FAILURE_MAX) {
            updateData.lockedUntil = new Date(Date.now() + TEMPORARY_LOCK_DURATION_MS);
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
          // PR #67: MFA 有効時は毎回 TOTP 検証を要求する。
          // ログイン直後は mfaVerified=false で返却し、middleware が /login/mfa へ誘導する。
          mfaEnabled: user.mfaEnabled,
          // PR #72: テーマ設定。layout.tsx で <html data-theme=...> に反映する。
          themePreference: user.themePreference,
          // PR #118: i18n 設定 (null = システムデフォルトを使う)。
          // 描画時は resolveTimezone/resolveLocale でフォールバック込みで解決する。
          timezone: user.timezone,
          locale: user.locale,
        };
      },
    }),
  ],
});
