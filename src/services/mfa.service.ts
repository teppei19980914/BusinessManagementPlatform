/**
 * MFA (TOTP) サービス（設計書: SPECIFICATION.md セクション 13.8, DESIGN.md セクション 9.17）
 */

import { prisma } from '@/lib/db';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { recordAuthEvent } from './auth-event.service';

const ENCRYPTION_KEY = process.env.NEXTAUTH_SECRET?.slice(0, 32).padEnd(32, '0') || '0'.repeat(32);
const ALGORITHM = 'aes-256-cbc';

function encrypt(text: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, 'utf-8'), iv);
  let encrypted = cipher.update(text, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText: string): string {
  const [ivHex, encrypted] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, 'utf-8'), iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');
  return decrypted;
}

async function getOtplib() {
  return await import('otplib');
}

/**
 * MFA 有効化ステップ1: TOTP シークレットを生成し、QR コード用の URI を返す
 */
export async function generateMfaSecret(
  userId: string,
): Promise<{ secret: string; otpauthUri: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('NOT_FOUND');

  const otplib = await getOtplib();
  const secret = otplib.generateSecret();
  const otpauthUri = otplib.generateURI({
    label: user.email,
    issuer: 'たすきば',
    secret,
  });

  await prisma.user.update({
    where: { id: userId },
    data: { mfaSecretEncrypted: encrypt(secret) },
  });

  return { secret, otpauthUri };
}

/**
 * MFA 有効化ステップ2: TOTP コードを検証し、有効化を完了する
 */
export async function enableMfa(
  userId: string,
  totpCode: string,
): Promise<{ success: boolean; error?: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.mfaSecretEncrypted) {
    return { success: false, error: 'MFA シークレットが生成されていません' };
  }

  const secret = decrypt(user.mfaSecretEncrypted);
  const otplib = await getOtplib();
  const result = otplib.verifySync({ token: totpCode, secret });
  const isValid = result.valid;

  if (!isValid) {
    return { success: false, error: 'コードが正しくありません' };
  }

  await prisma.user.update({
    where: { id: userId },
    data: { mfaEnabled: true, mfaEnabledAt: new Date() },
  });

  await recordAuthEvent({
    eventType: 'password_change',
    userId,
    detail: { action: 'mfa_enabled' },
  });

  return { success: true };
}

/**
 * MFA 無効化
 */
export async function disableMfa(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      mfaEnabled: false,
      mfaSecretEncrypted: null,
      mfaEnabledAt: null,
    },
  });

  await recordAuthEvent({
    eventType: 'password_change',
    userId,
    detail: { action: 'mfa_disabled' },
  });
}

/**
 * TOTP コード検証（ログイン時）
 */
export async function verifyTotp(userId: string, totpCode: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.mfaEnabled || !user.mfaSecretEncrypted) return false;

  const secret = decrypt(user.mfaSecretEncrypted);
  const otplib = await getOtplib();
  const result = otplib.verifySync({ token: totpCode, secret });
  return result.valid;
}
