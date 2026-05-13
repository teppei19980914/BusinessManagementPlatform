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

  // パスワード履歴チェック（直近5回の再利用禁止）— Phase 2-10: tenantId フィルタで二重防御
  const histories = await prisma.passwordHistory.findMany({
    where: { userId, tenantId: user.tenantId },
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
        // 2026-05-13 (security/jwt-invalidation, L-1 follow-up):
        //   旧実装は `tokenVersion: { increment: 1 }` で「他デバイスからの強制ログアウト」を
        //   行っていたが、**自分自身のセッションも即座に SESSION_INVALIDATED に弾かれる**
        //   重大バグを引き起こした (Step 2 で MFA setup が「再度ログインしてください」で停止)。
        //   getAuthenticatedUser は JWT.tokenVersion と DB.tokenVersion を比較するため、
        //   パスワード変更直後の JWT (= 古い値) が新しい DB 値と一致しなくなる。
        //   修正: 自分操作の changePassword では increment しない。他デバイス強制ログアウトは
        //   別 UI (「全デバイスからログアウト」ボタン等) で session.update 経由で実装する
        //   (post-MVP)。admin 操作 (updateUserStatus / updateUserRole / unlockAccount /
        //   deleteUser) では引き続き increment を維持 (= 他人の session を強制失効させる)。
        //   詳細: docs/knowledge/KDD_PATTERNS.md §5.X+46
      },
    }),
    // 履歴に追加 (Phase 2-10: tenantId 必須化)
    prisma.passwordHistory.create({
      data: {
        tenantId: user.tenantId,
        userId,
        passwordHash: newHash,
      },
    }),
  ]);

  await recordAuthEvent({
    eventType: 'password_change',
    tenantId: user.tenantId,
    userId,
    detail: { changedBy: 'self' },
  });

  return { success: true };
}

/**
 * 管理者によるアカウントロック解除
 *
 * T-21 (2026-04-28): 永続ロック実装に伴い、temporaryLockCount もリセットする。
 *   解除直後の再ログイン失敗で即座に永続ロック再発生してしまうのを防ぐため。
 *
 * Phase 2-10 (2026-05-10): tenantId 必須化 (admin が他テナントの user を unlock できないように)。
 */
export async function unlockAccount(
  userId: string,
  adminId: string,
  viewerTenantId: string,
): Promise<void> {
  // 越境 unlock 遮断: 自テナント所属の user に限定
  const updated = await prisma.user.updateMany({
    where: { id: userId, tenantId: viewerTenantId },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      permanentLock: false,
      temporaryLockCount: 0,
      // 2026-05-13 (security/jwt-invalidation, L-1): unlock 操作で
      //   既存 JWT を失効 (ロック中の旧 JWT があれば再ログイン強制)。
      tokenVersion: { increment: 1 },
    },
  });
  if (updated.count === 0) {
    throw new Error('NOT_FOUND');
  }

  await recordAuthEvent({
    eventType: 'account_reactivated',
    tenantId: viewerTenantId,
    userId,
    detail: { action: 'unlock', unlockedBy: adminId },
  });
}
