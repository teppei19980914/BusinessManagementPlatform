/**
 * メール検証サービス（設計書: SPECIFICATION.md セクション 13.3）
 */

import { prisma } from '@/lib/db';
import { getMailProvider } from '@/lib/mail';
import { randomBytes, createHash } from 'crypto';

const TOKEN_EXPIRY_HOURS = 24;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * メール検証トークンを生成し、検証メールを送信する
 */
export async function sendVerificationEmail(
  userId: string,
  email: string,
  baseUrl: string,
): Promise<void> {
  // 未使用の既存トークンを無効化
  await prisma.emailVerificationToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  // トークン生成
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

  await prisma.emailVerificationToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
    },
  });

  // 検証 URL
  const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${token}`;

  // メール送信
  const mailProvider = getMailProvider();
  await mailProvider.send({
    to: email,
    subject: 'たすきば - アカウントの有効化',
    html: `
      <h2>アカウントの有効化</h2>
      <p>以下のリンクをクリックしてアカウントを有効化してください。</p>
      <p><a href="${verifyUrl}">アカウントを有効化する</a></p>
      <p>このリンクは ${TOKEN_EXPIRY_HOURS} 時間有効です。</p>
      <p>心当たりがない場合は、このメールを無視してください。</p>
    `,
    text: `アカウントの有効化\n\n以下のURLにアクセスしてアカウントを有効化してください。\n${verifyUrl}\n\nこのリンクは${TOKEN_EXPIRY_HOURS}時間有効です。`,
  });
}

/**
 * メール検証トークンを検証し、アカウントを有効化する
 */
export async function verifyEmail(
  token: string,
): Promise<{ success: boolean; error?: string }> {
  const tokenHash = hashToken(token);

  const record = await prisma.emailVerificationToken.findFirst({
    where: { tokenHash },
  });

  if (!record) {
    return { success: false, error: '無効なリンクです' };
  }

  if (record.usedAt) {
    return { success: false, error: '既に使用されたリンクです' };
  }

  if (record.expiresAt < new Date()) {
    return { success: false, error: '有効期限切れです。管理者に再送を依頼してください' };
  }

  // トークンを使用済みに + ユーザを有効化
  await prisma.$transaction([
    prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: record.userId },
      data: { isActive: true, deletedAt: null },
    }),
  ]);

  return { success: true };
}
