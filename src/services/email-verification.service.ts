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
    // P-H (2026-05-08): 送信種別ラベル (ログ集計用)
    type: 'invitation',
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
 * トークンを検証し、パスワード設定 + リカバリーコード生成 + アカウント有効化 (+ super_admin は MFA 準備) を行う。
 *
 * PR #91 (2026-04) 改訂: 全 admin に MFA を強制していた。
 * 2026-05-09 (#11) 改訂: 「テナント管理者 (systemRole='admin')」の MFA を任意化。
 *   テナント管理者は社内の運用者で、MFA 強制が業務開始のハードルになるという
 *   ユーザフィードバックに基づく。プラットフォーム運営者である super_admin は
 *   引き続き MFA を強制する (横断アクセスによる影響範囲が大きいため)。
 *
 *   - super_admin: 本関数でパスワード + MFA シークレット生成まで行い、後続の
 *     `setupInitialMfa` で TOTP 検証に成功したときに初めて isActive=true /
 *     deletedAt=null / mfaEnabled=true となる。
 *   - admin / general: 従来 general 同様に本関数で即時有効化。MFA は任意で
 *     設定画面から自分で有効化可能。
 *
 * 返却値:
 *   - admin / general: { success, recoveryCodes }
 *   - super_admin   : { success, recoveryCodes, requiresMfa: true, mfa: { otpauthUri, qrCodeDataUrl } }
 *                     (requiresMfa=true で UI 側が MFA ステップを表示する)
 */
export async function setupPassword(
  token: string,
  passwordHash: string,
): Promise<{
  success: boolean;
  recoveryCodes?: string[];
  requiresMfa?: boolean;
  mfa?: { otpauthUri: string; qrCodeDataUrl: string };
  error?: string;
}> {
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

  // 対象ユーザを取得 (admin 分岐に使う)
  const user = await prisma.user.findUnique({
    where: { id: record.userId },
  });
  if (!user) {
    return { success: false, error: '対象ユーザが見つかりません' };
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

  // 2026-05-09 (#11): 強制 MFA は super_admin のみ。テナント管理者 (admin) は
  //   一般ユーザと同じ即時有効化フローに合流させる。
  const isSuperAdmin = user.systemRole === 'super_admin';

  if (isSuperAdmin) {
    // super_admin は MFA セットアップを必須化する (横断アクセス権限の保護)。
    // パスワード保存 + MFA シークレット生成 (まだ mfaEnabled=false) + recoveryCodes 作成。
    // **isActive / deletedAt / token.usedAt は変更しない** (後続の setupInitialMfa で
    // TOTP 検証に成功したときに初めて一括更新)。
    const { generateMfaSecret } = await import('./mfa.service');
    const { default: QRCode } = await import('qrcode');

    // mfaSecretEncrypted は generateMfaSecret 内で user.update される。
    // ここで password / recoveryCodes 側の transaction を走らせる前に行うことで、
    // いずれか失敗した場合でも孤児 secret が残るが、次回再試行で上書きされる。
    const { otpauthUri } = await generateMfaSecret(user.id);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          forcePasswordChange: false,
          // 明示的に mfaEnabled=false を保つ (念のため)
          mfaEnabled: false,
        },
      }),
      prisma.recoveryCode.createMany({
        data: recoveryCodeHashes.map((h) => ({
          userId: record.userId,
          ...h,
        })),
      }),
    ]);

    return {
      success: true,
      recoveryCodes,
      requiresMfa: true,
      mfa: { otpauthUri, qrCodeDataUrl },
    };
  }

  // 一般ユーザ: 従来通り即時有効化
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
 * PR #91: admin 初期セットアップの最終段階 — TOTP 検証 + アカウント有効化。
 *
 * 呼出前提:
 *   setupPassword() を admin で成功済み (mfaSecretEncrypted 設定済 / token 未使用)。
 *   クライアントは認証アプリで生成した 6 桁 TOTP コードと token を送ってくる。
 *
 * 成功時の副作用:
 *   - emailVerificationToken.usedAt = now
 *   - user.isActive = true / deletedAt = null / mfaEnabled = true / mfaEnabledAt = now
 *
 * @throws {Error} 各種失敗ケースは error フィールドで返却 (throw しない)
 */
export async function setupInitialMfa(
  token: string,
  totpCode: string,
): Promise<{ success: boolean; error?: string }> {
  const tokenHash = hashToken(token);

  const record = await prisma.emailVerificationToken.findFirst({
    where: { tokenHash },
  });
  if (!record) return { success: false, error: '無効なリンクです' };
  if (record.usedAt) return { success: false, error: '既に使用されたリンクです' };
  if (record.expiresAt < new Date()) {
    return { success: false, error: '有効期限切れです。管理者に再送を依頼してください' };
  }

  const user = await prisma.user.findUnique({ where: { id: record.userId } });
  if (!user) return { success: false, error: '対象ユーザが見つかりません' };
  if (!user.mfaSecretEncrypted) {
    return {
      success: false,
      error: 'MFA シークレットが未設定です。パスワード設定からやり直してください',
    };
  }

  // TOTP 検証は mfa.service の decrypt + verify を再利用する。
  // 既存 verifyTotp は mfaEnabled=true を要求するが、初期セットアップ時点では
  // mfaEnabled=false なので専用ルーチンを呼び出す必要がある。
  // 設計簡易化のため、mfa.service から低レベル API を export してもよいが、
  // ここでは otplib を直接呼ぶ (暗号化キーはどちらも NEXTAUTH_SECRET 由来で揃う)。
  const { verifyInitialTotpSecret } = await import('./mfa.service');
  const valid = await verifyInitialTotpSecret(user.mfaSecretEncrypted, totpCode);
  if (!valid) {
    return { success: false, error: '6 桁のコードが正しくありません' };
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { usedAt: now },
    }),
    prisma.user.update({
      where: { id: record.userId },
      data: {
        isActive: true,
        deletedAt: null,
        mfaEnabled: true,
        mfaEnabledAt: now,
      },
    }),
  ]);

  return { success: true };
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
