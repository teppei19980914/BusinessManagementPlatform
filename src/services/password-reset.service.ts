/**
 * パスワードリセットサービス（設計書: SPECIFICATION.md セクション 13.7）
 * 本人確認: メールアドレス + リカバリーコード
 */

import { prisma } from '@/lib/db';
import { compare, hash } from 'bcryptjs';
import { randomBytes, createHash } from 'crypto';
import { recordAuthEvent } from './auth-event.service';

const BCRYPT_COST = 12;
const TOKEN_EXPIRY_MINUTES = 30;
const PASSWORD_HISTORY_COUNT = 5;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * ステップ1: メールアドレス + リカバリーコードで本人確認し、リセットトークンを発行
 */
export async function verifyAndIssueResetToken(
  email: string,
  recoveryCode: string,
): Promise<{ success: boolean; token?: string; error?: string }> {
  const user = await prisma.user.findFirst({
    where: { email, deletedAt: null },
  });

  if (!user) {
    return { success: false, error: 'メールアドレスまたはリカバリーコードが正しくありません' };
  }

  // 未使用のリカバリーコードと照合
  const codes = await prisma.recoveryCode.findMany({
    where: { userId: user.id, usedAt: null },
  });

  let matchedCodeId: string | null = null;
  for (const code of codes) {
    const isMatch = await compare(recoveryCode, code.codeHash);
    if (isMatch) {
      matchedCodeId = code.id;
      break;
    }
  }

  if (!matchedCodeId) {
    await recordAuthEvent({
      eventType: 'login_failure',
      userId: user.id,
      email,
      detail: { reason: 'invalid_recovery_code', action: 'password_reset' },
    });
    return { success: false, error: 'メールアドレスまたはリカバリーコードが正しくありません' };
  }

  // リカバリーコードを使用済みに
  await prisma.recoveryCode.update({
    where: { id: matchedCodeId },
    data: { usedAt: new Date() },
  });

  // リセットトークン発行
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60 * 1000);

  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash, expiresAt },
  });

  return { success: true, token };
}

/**
 * ステップ2: リセットトークンで新パスワードを設定
 */
export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<{ success: boolean; error?: string }> {
  const tokenHash = hashToken(token);

  const record = await prisma.passwordResetToken.findFirst({
    where: { tokenHash },
  });

  if (!record) return { success: false, error: '無効なリンクです' };
  if (record.usedAt) return { success: false, error: '既に使用されたリンクです' };
  if (record.expiresAt < new Date()) return { success: false, error: '有効期限切れです' };

  // パスワード履歴チェック
  const histories = await prisma.passwordHistory.findMany({
    where: { userId: record.userId },
    orderBy: { createdAt: 'desc' },
    take: PASSWORD_HISTORY_COUNT,
  });

  for (const h of histories) {
    const isReused = await compare(newPassword, h.passwordHash);
    if (isReused) {
      return { success: false, error: '直近5回のパスワードは再利用できません' };
    }
  }

  const newHash = await hash(newPassword, BCRYPT_COST);

  await prisma.$transaction([
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: record.userId },
      data: {
        passwordHash: newHash,
        forcePasswordChange: false,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    }),
    prisma.passwordHistory.create({
      data: { userId: record.userId, passwordHash: newHash },
    }),
  ]);

  await recordAuthEvent({
    eventType: 'password_change',
    userId: record.userId,
    detail: { action: 'reset' },
  });

  return { success: true };
}
