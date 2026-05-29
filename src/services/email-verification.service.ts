/**
 * メール検証サービス（設計書: SPECIFICATION.md セクション 13.3）
 */

import { prisma } from '@/lib/db';
import { getMailProvider } from '@/lib/mail';
import { randomBytes, createHash } from 'crypto';
import { EMAIL_VERIFICATION_TOKEN_EXPIRY_HOURS as TOKEN_EXPIRY_HOURS } from '@/config';
import { CONTACT_FORM_URL } from '@/config/operator';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * HTML interpolation 用の XSS escape。
 *
 * feat/email-login-info-and-no-reply (2026-05-29):
 *   招待メール本文に受信メールアドレスを `${email}` で埋め込むにあたり、
 *   zod の `.email()` 検証 (validators/auth.ts) と二重防御するため追加。
 *   tenant.slug は regex `[a-z0-9-]` で別途厳格化されており escape 不要だが、
 *   email は RFC 5321 quoted-string で `"` 等が許容され得るため明示的に escape する。
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * メール検証トークンを生成し、検証メールを送信する
 * @throws {EmailSendError} メール送信に失敗した場合
 *
 * Phase 2-10 (2026-05-10): tenantId 必須化。token 漏洩時の越境再利用を遮断するため、
 *   token は所属テナント内でのみ有効。verify 時に findFirst が tenantId フィルタを併用する。
 */
export async function sendVerificationEmail(
  userId: string,
  tenantId: string,
  email: string,
  baseUrl: string,
): Promise<void> {
  // 未使用の既存トークンを無効化 (自テナント + 同 user に限定 = 二重防御)
  await prisma.emailVerificationToken.updateMany({
    where: { userId, tenantId, usedAt: null },
    data: { usedAt: new Date() },
  });

  // ADR-0016 (2026-05-20): tenant slug 解決 (= URL に埋め込む)
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { slug: true },
  });
  if (!tenant) {
    throw new Error(`Tenant not found for id=${tenantId}`);
  }

  // トークン生成
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

  await prisma.emailVerificationToken.create({
    data: {
      tenantId,
      userId,
      tokenHash,
      expiresAt,
    },
  });

  // ADR-0016 (2026-05-20): url-builder 経由で生成 (= 将来 Option A 移行容易化)
  const { buildSetupPasswordUrl } = await import('@/lib/url-builder');
  const setupUrl = buildSetupPasswordUrl(tenant.slug, token, baseUrl);

  // 招待メール送信
  // Phase 1 (2026-05-23 / feat/signup-email-resend-ux):
  //   組織 ID (tenant.slug) を本文に明示。ログイン時の組織 ID 必須化 (ADR-0016) で
  //   「自分の組織 ID を覚えていない」ロックアウト事故を防ぐ。
  //   - メール本文は永続的に受信者の inbox に残るため、ブラウザ閉じ後でも再確認可能
  //   - 「【重要】保存推奨」表記で重要性を強調
  // feat/email-login-info-and-no-reply (2026-05-29):
  //   ログイン情報の網羅性向上のため受信メールアドレスも本文に明示。
  //   複数アドレス使い分けや ML 受信時の取り違え事故を予防する。
  //   さらに「自動送信 / 返信不可」no-reply 文言をフッタに追加し、運営問合せ窓口の
  //   迷い (返信 vs LP フォーム) を解消する (= 本サービスは inbound mail 受信せず)。
  const mailProvider = getMailProvider();
  const result = await mailProvider.send({
    to: email,
    // P-H (2026-05-08): 送信種別ラベル (ログ集計用)
    type: 'invitation',
    subject: 'たすきば - アカウントの設定',
    html: `
      <h2>たすきば へようこそ</h2>
      <p>あなたのアカウントが作成されました。以下のリンクからパスワードを設定してください。</p>
      <div style="border: 1px solid #e0e0e0; border-radius: 6px; padding: 16px; margin: 16px 0; background-color: #f9fafb;">
        <p style="margin: 0 0 8px 0; font-weight: bold; color: #d97706;">【重要】ログイン情報 (再ログイン時に必要)</p>
        <p style="margin: 0 0 4px 0;">あなたの組織 ID:</p>
        <p style="margin: 0; font-family: monospace; font-size: 18px; font-weight: bold;">${tenant.slug}</p>
        <p style="margin: 12px 0 4px 0;">あなたのメールアドレス:</p>
        <p style="margin: 0; font-family: monospace; font-size: 16px; font-weight: bold;">${escapeHtml(email)}</p>
        <p style="margin: 8px 0 0 0; font-size: 12px; color: #6b7280;">本メールは大切に保存してください。ログイン画面で組織 ID とメールアドレスの入力が必要になります。</p>
      </div>
      <p><a href="${setupUrl}">パスワードを設定する</a></p>
      <p>このリンクは ${TOKEN_EXPIRY_HOURS} 時間有効です。</p>
      <p>心当たりがない場合は、このメールを無視してください。</p>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0 12px 0;" />
      <p style="font-size: 12px; color: #6b7280; margin: 0 0 6px 0;">※ このメールはシステムからの自動送信 (noreply@tasukiba.com) です。本メールへの返信は受信できません。</p>
      <p style="font-size: 12px; color: #6b7280; margin: 0;">お問い合わせは <a href="${CONTACT_FORM_URL}">公式 LP のお問い合わせフォーム</a> から「お問い合わせ種別: たすきばに関するお問い合わせ」をご選択ください。</p>
    `,
    text:
      `たすきば へようこそ\n\n` +
      `あなたのアカウントが作成されました。\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `【重要】ログイン情報 (再ログイン時に必要)\n` +
      `あなたの組織 ID: ${tenant.slug}\n` +
      `あなたのメールアドレス: ${email}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `本メールは大切に保存してください。ログイン画面で組織 ID とメールアドレスの入力が必要になります。\n\n` +
      `以下のURLからパスワードを設定してください。\n${setupUrl}\n\n` +
      `このリンクは${TOKEN_EXPIRY_HOURS}時間有効です。\n\n` +
      `――――――――――――――――――\n` +
      `※ このメールはシステムからの自動送信 (noreply@tasukiba.com) です。本メールへの返信は受信できません。\n` +
      `お問い合わせは公式 LP のお問い合わせフォームから「お問い合わせ種別: たすきばに関するお問い合わせ」をご選択ください。\n` +
      `${CONTACT_FORM_URL}`,
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

// ================================================================
// 招待メール再送 (Phase 1 / feat/signup-email-resend-ux / 2026-05-23)
// ================================================================

export type ResendVerificationResult =
  | { ok: true; reason: 'sent' }
  /**
   * enumeration 防止のため、サインアップ完了済 / 該当ユーザ不在 / 既に有効化済等の
   * 「再送が成立しないケース」は呼出側に詳細を伝えず ok=true で返す。
   * 内部処理としては「何もしなかった」を表すが、UI には「再送しました」と
   * 同等の体感で返すことで、悪意ある列挙者に対する手がかりを与えない。
   */
  | { ok: true; reason: 'silent_skip' }
  | { ok: false; reason: 'EMAIL_SEND_FAILED'; message: string };

/**
 * 招待メールを再送する (Phase 1 / feat/signup-email-resend-ux)。
 *
 * 設計:
 *   - **enumeration 防止**: tenant 不在 / user 不在 / 既に活性化済の場合も silent_skip で 200 を返す
 *   - **既存 sendVerificationEmail を再利用**: 内部で旧 token を usedAt=now で無効化し新 token を発行する
 *   - **Rate Limit は呼出側 (route) で実施**: 本サービスはビジネスロジックのみに集中
 *
 * 制約:
 *   - User.isActive=false (= まだメール検証していない) ユーザのみが対象
 *   - 既に isActive=true のユーザは silent_skip (= サインアップ完了済として何もしない)
 */
export async function resendVerificationEmail(
  email: string,
  tenantSlug: string,
  baseUrl: string,
): Promise<ResendVerificationResult> {
  // 1. tenant 解決
  const tenant = await prisma.tenant.findUnique({
    where: { slug: tenantSlug },
    select: { id: true, deletedAt: true },
  });
  // enumeration 防止: tenant 不在 / 削除済テナントは silent_skip
  if (!tenant || tenant.deletedAt != null) {
    return { ok: true, reason: 'silent_skip' };
  }

  // 2. user 解決 (tenant-scoped + isActive=false の pending verification ユーザに限定)
  const user = await prisma.user.findFirst({
    where: {
      tenantId: tenant.id,
      email,
      isActive: false,
      deletedAt: null,
    },
    select: { id: true },
  });
  // enumeration 防止: user 不在 / 既に isActive=true は silent_skip
  if (!user) {
    return { ok: true, reason: 'silent_skip' };
  }

  // 3. 既存 sendVerificationEmail を呼ぶ (= 旧 token 無効化 + 新 token 発行 + メール送信)
  try {
    await sendVerificationEmail(user.id, tenant.id, email, baseUrl);
    return { ok: true, reason: 'sent' };
  } catch (e) {
    if (e instanceof EmailSendError) {
      return {
        ok: false,
        reason: 'EMAIL_SEND_FAILED',
        message: 'メール送信に失敗しました。時間をおいて再度お試しください。',
      };
    }
    throw e;
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
        // Phase 2-10: tenantId 必須化 (token record の tenantId を継承)
        data: recoveryCodeHashes.map((h) => ({
          tenantId: record.tenantId,
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
      // Phase 2-10: tenantId 必須化 (token record の tenantId を継承)
      data: recoveryCodeHashes.map((h) => ({
        tenantId: record.tenantId,
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
