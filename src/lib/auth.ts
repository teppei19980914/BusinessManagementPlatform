import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { compare } from 'bcryptjs';
import { prisma } from '@/lib/db';
import { recordAuthEvent } from '@/services/auth-event.service';
import { authConfig } from './auth.config';
import { LOGIN_FAILURE_MAX, TEMPORARY_LOCK_DURATION_MS, PERMANENT_LOCK_THRESHOLD } from '@/config';

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
            // 一時ロック発生: failedLoginCount をリセットし lockedUntil をセット。
            // T-21: 一時ロック累積カウンタもインクリメントし、閾値到達なら永続ロックに昇格。
            updateData.lockedUntil = new Date(Date.now() + TEMPORARY_LOCK_DURATION_MS);
            updateData.failedLoginCount = 0;
            const newTemporaryLockCount = user.temporaryLockCount + 1;
            updateData.temporaryLockCount = newTemporaryLockCount;
            if (newTemporaryLockCount >= PERMANENT_LOCK_THRESHOLD) {
              updateData.permanentLock = true;
              await recordAuthEvent({ eventType: 'lock', userId: user.id, email, detail: { lockType: 'permanent', temporaryLockCount: newTemporaryLockCount } });
            } else {
              await recordAuthEvent({ eventType: 'lock', userId: user.id, email, detail: { lockType: 'temporary', temporaryLockCount: newTemporaryLockCount } });
            }
          }

          await prisma.user.update({
            where: { id: user.id },
            data: updateData,
          });

          await recordAuthEvent({ eventType: 'login_failure', userId: user.id, email, detail: { reason: 'invalid_password' } });
          return null;
        }

        // ログイン成功: 失敗系カウンタを全てリセット。
        // T-21: temporaryLockCount もリセット (一時ロックを乗り越えて成功 = 正規ユーザの可能性が高い)。
        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginCount: 0,
            lockedUntil: null,
            temporaryLockCount: 0,
            lastLoginAt: new Date(),
          },
        });

        await recordAuthEvent({ eventType: 'login_success', userId: user.id, email });

        return {
          id: user.id,
          // PR #2-b (T-03): テナント境界の起点。session.user.tenantId に伝播し、
          //   後続のすべての API ルートが requireSameTenant() で同テナント検証する。
          tenantId: user.tenantId,
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
