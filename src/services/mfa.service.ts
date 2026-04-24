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
 * TOTP 検証時に許容する時刻ずれ (秒単位)。
 *
 * **背景**: otplib の `verifySync` は既定で `epochTolerance=0` (生成時刻と検証時刻が
 * **同一 period 内** にないと拒否)。period=30 秒のため、TOTP コード生成 → ネットワーク往復 →
 * サーバ検証の間に **30 秒境界を跨ぐと fail** する。これは高並列 CI 環境で発生しやすく、
 * PR #110 の CI で MFA verify が 400 を返す現象を引き起こした (E2E spec 01 Step 5)。
 *
 * **対策**: `epochTolerance=30` を設定し、**前後 1 window (± 30 秒)** の時刻ずれを許容する。
 * これは業界標準 (Google Authenticator / AWS MFA / RFC 6238 §5.2 推奨) で、セキュリティ上の
 * 実害はない。ブルートフォース耐性は 10^6 コードの TOTP 空間で十分 (1 秒 / 1 コードの総当たりでも
 * 11 日かかる)。
 *
 * **RFC 6238 §5.2 (Validation and Time-Step Size)** より抜粋:
 *   > "We RECOMMEND that at most one time step is allowed as the network delay."
 *
 * 値: 30 秒 (= 1 period 分の対称許容)
 */
const TOTP_EPOCH_TOLERANCE_SEC = 30;

/**
 * MFA verify 専用のレート制限設定 (PR #116 / 2026-04-24)。
 *
 * パスワードロック (`failedLoginCount` / `lockedUntil`) とは **別系統** で管理する理由:
 *   - 失敗原因 (パスワード / MFA) を分けて admin 画面で可視化するため
 *   - recovery code による解除は **MFA ロックのみ** が対象であるべきだから
 *     (パスワード側で間違えてロックされた人が recovery code で解除できてしまう矛盾を避ける)
 *
 * 閾値: 3 回 (パスワードの 5 回より厳しく、TOTP ブルートフォース耐性を確保)
 * ロック期間: 30 分 (パスワードロックと同じ)
 * 恒久ロック: **設けない** — recovery code で自己解除可能な経路があるため、
 *   「永遠にログインできない」状態を admin 介入なしで生む必要はない。
 */
export const MFA_FAIL_LIMIT = 3;
export const MFA_LOCK_DURATION_MS = 30 * 60 * 1000;

export class MfaLockedError extends Error {
  constructor(public lockedUntil: Date) {
    super('MFA_LOCKED');
    this.name = 'MfaLockedError';
  }
}

/**
 * MFA 有効化ステップ1: TOTP シークレットを生成し、QR コード用の URI を返す
 */
export async function generateMfaSecret(
  userId: string,
): Promise<{ secret: string; otpauthUri: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('NOT_FOUND');

  // PR #114 (2026-04-24 セキュリティ監査 L-2): 既に MFA 有効化済のユーザが再度 setup を
  // 叩けるとシークレット平文が再取得でき、ブラウザ Network 経由で現行 MFA 秘密情報が
  // 抜き取れる。以降の有効化フローは「解除 → 再 setup」の順序を強制する。
  if (user.mfaEnabled) {
    throw new Error('ALREADY_ENABLED');
  }

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
  const result = otplib.verifySync({
    token: totpCode,
    secret,
    epochTolerance: TOTP_EPOCH_TOLERANCE_SEC,
  });
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
 *
 * PR #91: admin (システム管理者) は MFA を無効化できない。
 * 呼出前に API route 層でも admin チェックを行うが、サービス層でも防御多層化として拒否する。
 *
 * @throws {Error} 'CANNOT_DISABLE_ADMIN_MFA' — admin が対象の場合
 */
export async function disableMfa(userId: string): Promise<void> {
  // PR #91: admin は MFA 必須 — 無効化禁止 (サービス層防御)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { systemRole: true },
  });
  if (user?.systemRole === 'admin') {
    throw new Error('CANNOT_DISABLE_ADMIN_MFA');
  }

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
 * TOTP コード検証（ログイン時）。
 *
 * PR #116 (2026-04-24): レート制限機構を組み込み。
 *   - 現在 mfaLockedUntil が未来 → `MfaLockedError` を throw
 *   - 検証成功 → `mfaFailedCount = 0`, `mfaLockedUntil = null` にリセット
 *   - 検証失敗 → `mfaFailedCount` increment。MFA_FAIL_LIMIT に達したら
 *     `mfaLockedUntil = now + 30min` にロック
 *
 * MFA 未有効化ユーザに対しては false を返すのみ (カウンタ変更なし)。
 *
 * @throws {MfaLockedError} ロック中にアクセスがあった場合 (route 層で 429 に変換)
 */
export async function verifyTotp(userId: string, totpCode: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.mfaEnabled || !user.mfaSecretEncrypted) return false;

  // ロック期間中: 即座に拒否 (TOTP 検証処理自体を走らせない)
  if (user.mfaLockedUntil && user.mfaLockedUntil.getTime() > Date.now()) {
    throw new MfaLockedError(user.mfaLockedUntil);
  }

  const secret = decrypt(user.mfaSecretEncrypted);
  const otplib = await getOtplib();
  const result = otplib.verifySync({
    token: totpCode,
    secret,
    epochTolerance: TOTP_EPOCH_TOLERANCE_SEC,
  });

  if (result.valid) {
    // 成功: カウンタ + ロック状態をクリア (過去にカウントが溜まっていた場合も)
    if (user.mfaFailedCount > 0 || user.mfaLockedUntil) {
      await prisma.user.update({
        where: { id: userId },
        data: { mfaFailedCount: 0, mfaLockedUntil: null },
      });
    }
    return true;
  }

  // 失敗: カウンタ increment + 閾値到達なら lockedUntil セット
  const newCount = user.mfaFailedCount + 1;
  const shouldLock = newCount >= MFA_FAIL_LIMIT;
  await prisma.user.update({
    where: { id: userId },
    data: {
      mfaFailedCount: shouldLock ? 0 : newCount, // ロック時は 0 に戻し「次ロック」のための新サイクル開始
      mfaLockedUntil: shouldLock ? new Date(Date.now() + MFA_LOCK_DURATION_MS) : undefined,
    },
  });

  if (shouldLock) {
    await recordAuthEvent({
      eventType: 'lock',
      userId,
      detail: {
        lockType: 'mfa_temporary',
        reason: 'mfa_failure_threshold_exceeded',
        threshold: MFA_FAIL_LIMIT,
        lockDurationMinutes: MFA_LOCK_DURATION_MS / 60 / 1000,
      },
    });
    // ロック成立後は、本回の失敗呼び出しに対しても即座に lockError を throw して
    // 呼出側 UI で「ロックされました」を明示する
    throw new MfaLockedError(new Date(Date.now() + MFA_LOCK_DURATION_MS));
  }

  return false;
}

/**
 * recovery code 使用成功時に MFA 失敗カウント + ロックをリセットする (PR #116)。
 *
 * verify route が `body.recoveryCode` 経路で成功した場合に呼ぶ。TOTP 正解時と
 * 同じ扱い (カウンタ 0、lockedUntil null)。
 */
export async function resetMfaLockOnRecoveryCodeUse(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { mfaFailedCount: 0, mfaLockedUntil: null },
  });
}

/**
 * admin による MFA ロック手動解除 (PR #116)。
 *
 * `/api/admin/users/[userId]/unlock` から MFA 系統も解除できるよう追加。
 * 既存の `failedLoginCount` / `lockedUntil` 系統には影響しない。
 */
export async function unlockMfaByAdmin(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { mfaFailedCount: 0, mfaLockedUntil: null },
  });
}

/**
 * PR #91: admin 初期セットアップ専用の TOTP 検証ヘルパー。
 *
 * 通常の verifyTotp() は user.mfaEnabled=true を前提にするため、
 * 初期セットアップ中 (mfaEnabled=false, secret のみ格納済) では使えない。
 * 本関数は **暗号化済シークレット文字列を直接受け取り** 検証するので、
 * 呼び出し側が user row 参照を持っていれば mfaEnabled 状態と独立に検証可能。
 *
 * 用途: email-verification.service.ts setupInitialMfa の TOTP 検証のみ。
 */
export async function verifyInitialTotpSecret(
  encryptedSecret: string,
  totpCode: string,
): Promise<boolean> {
  const secret = decrypt(encryptedSecret);
  const otplib = await getOtplib();
  const result = otplib.verifySync({
    token: totpCode,
    secret,
    epochTolerance: TOTP_EPOCH_TOLERANCE_SEC,
  });
  return result.valid;
}
