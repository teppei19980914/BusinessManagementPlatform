/**
 * メール検証サービス（設計書: SPECIFICATION.md セクション 13.3）
 */

import { prisma } from '@/lib/db';
import { getMailProvider } from '@/lib/mail';
import { randomBytes, createHash } from 'crypto';
import { EMAIL_VERIFICATION_TOKEN_EXPIRY_HOURS as TOKEN_EXPIRY_HOURS } from '@/config';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * メール検証トークンを生成し、検証メールを送信する
 * @throws {EmailSendError} メール送信に失敗した場合
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

  // パスワード設定 URL
  const setupUrl = `${baseUrl}/setup-password?token=${token}`;

  // 招待メール送信
  const mailProvider = getMailProvider();
  const result = await mailProvider.send({
    to: email,
    subject: 'たすきば - アカウントの設定',
    html: `
      <h2>たすきば へようこそ</h2>
      <p>あなたのアカウントが作成されました。以下のリンクからパスワードを設定してください。</p>
      <p><a href="${setupUrl}">パスワードを設定する</a></p>
      <p>このリンクは ${TOKEN_EXPIRY_HOURS} 時間有効です。</p>
      <p>心当たりがない場合は、このメールを無視してください。</p>
    `,
    text: `たすきば へようこそ\n\nあなたのアカウントが作成されました。以下のURLからパスワードを設定してください。\n${setupUrl}\n\nこのリンクは${TOKEN_EXPIRY_HOURS}時間有効です。`,
  });

  if (!result.success) {
    throw new EmailSendError(result.error || 'メール送信に失敗しました');
  }
}

/**
 * メール送信失敗を表すエラー
 */
export class EmailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailSendError';
  }
}

/**
 * トークンを検証する（パスワード設定画面の初期表示用）
 */
export async function validateToken(
  token: string,
): Promise<{ valid: boolean; error?: string }> {
  const tokenHash = hashToken(token);

  const record = await prisma.emailVerificationToken.findFirst({
    where: { tokenHash },
  });

  if (!record) {
    return { valid: false, error: '無効なリンクです' };
  }

  if (record.usedAt) {
    return { valid: false, error: '既に使用されたリンクです' };
  }

  if (record.expiresAt < new Date()) {
    return { valid: false, error: '有効期限切れです。管理者に再送を依頼してください' };
  }

  return { valid: true };
}

/**
 * トークンを検証し、パスワード設定 + リカバリーコード生成 + アカウント有効化を行う
 */
export async function setupPassword(
  token: string,
  passwordHash: string,
): Promise<{ success: boolean; recoveryCodes?: string[]; error?: string }> {
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

  // リカバリーコード生成
  const { hash } = await import('bcryptjs');
  const { randomBytes } = await import('crypto');
  const { RECOVERY_CODE_COUNT, RECOVERY_CODE_CHARSET, BCRYPT_COST } = await import('@/config');

  const recoveryCodes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const bytes = randomBytes(8);
    const code = Array.from(bytes)
      .map((b) => RECOVERY_CODE_CHARSET[b % RECOVERY_CODE_CHARSET.length])
      .join('')
      .replace(/(.{4})(.{4})/, '$1-$2');
    recoveryCodes.push(code);
  }

  const recoveryCodeHashes = await Promise.all(
    recoveryCodes.map(async (code) => ({
      codeHash: await hash(code, BCRYPT_COST),
    })),
  );

  // トランザクション: トークン使用済み + パスワード設定 + リカバリーコード + 有効化
  await prisma.$transaction([
    prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: record.userId },
      data: {
        passwordHash,
        isActive: true,
        deletedAt: null,
        forcePasswordChange: false,
      },
    }),
    prisma.recoveryCode.createMany({
      data: recoveryCodeHashes.map((h) => ({
        userId: record.userId,
        ...h,
      })),
    }),
  ]);

  return { success: true, recoveryCodes };
}

/**
 * メール検証トークンを検証し、アカウントを有効化する（後方互換）
 */
export async function verifyEmail(
  token: string,
): Promise<{ success: boolean; error?: string }> {
  const result = await validateToken(token);
  if (!result.valid) {
    return { success: false, error: result.error };
  }

  const tokenHash = hashToken(token);
  const record = await prisma.emailVerificationToken.findFirst({
    where: { tokenHash },
  });

  if (!record) {
    return { success: false, error: '無効なリンクです' };
  }

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
