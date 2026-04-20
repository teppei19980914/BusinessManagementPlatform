/**
 * パスワード管理サービス（設計書: SPECIFICATION.md セクション 13.6, 13.7）
 */

import { prisma } from '@/lib/db';
import { hash, compare } from 'bcryptjs';
import { recordAuthEvent } from './auth-event.service';
import { BCRYPT_COST, PASSWORD_HISTORY_COUNT } from '@/config';

/**
 * パスワードを変更する（ログイン中のユーザ自身）
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ success: boolean; error?: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { success: false, error: 'ユーザが見つかりません' };

  // 現在のパスワード照合
  const isValid = await compare(currentPassword, user.passwordHash);
  if (!isValid) return { success: false, error: '現在のパスワードが正しくありません' };

  // パスワード履歴チェック（直近5回の再利用禁止）
  const histories = await prisma.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: PASSWORD_HISTORY_COUNT,
  });

  for (const h of histories) {
    const isReused = await compare(newPassword, h.passwordHash);
    if (isReused) {
      return { success: false, error: '直近5回のパスワードは再利用できません' };
    }
  }

  // 現在のパスワードとの重複もチェック
  const isSameAsCurrent = await compare(newPassword, user.passwordHash);
  if (isSameAsCurrent) {
    return { success: false, error: '現在のパスワードと同じパスワードは設定できません' };
  }

  // 新パスワードをハッシュ化して更新
  const newHash = await hash(newPassword, BCRYPT_COST);

  await prisma.$transaction([
    // パスワード更新
    prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: newHash,
        forcePasswordChange: false,
      },
    }),
    // 履歴に追加
    prisma.passwordHistory.create({
      data: {
        userId,
        passwordHash: newHash,
      },
    }),
  ]);

  await recordAuthEvent({
    eventType: 'password_change',
    userId,
    detail: { changedBy: 'self' },
  });

  return { success: true };
}

/**
 * 管理者によるアカウントロック解除
 */
export async function unlockAccount(
  userId: string,
  adminId: string,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      permanentLock: false,
    },
  });

  await recordAuthEvent({
    eventType: 'account_reactivated',
    userId,
    detail: { action: 'unlock', unlockedBy: adminId },
  });
}
