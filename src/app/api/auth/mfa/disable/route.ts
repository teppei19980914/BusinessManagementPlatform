/**
 * POST /api/auth/mfa/disable - MFA 無効化
 *
 * 役割:
 *   ログイン中ユーザが自分の MFA を無効化する。
 *   2026-05-09 (#11): MFA 強制対象を super_admin のみに限定。super_admin は引き続き
 *     無効化禁止 (横断アクセス保護)。テナント管理者 (admin) と一般ユーザは無効化可能。
 *
 * 認可: getAuthenticatedUser (本人。super_admin はサービス側で再拒否)
 * 監査: disableMfa サービス内で auth_event_logs (eventType=mfa_disabled) を記録。
 *
 * 2026-05-13 (security/auth-secret-hardening, B-5): 現在パスワード + (MFA 有効時)
 *   現在 TOTP の再認証を必須化。セッション cookie 漏洩時に MFA 無効化 → 以降被害者の
 *   ログインに MFA 要求されない、という攻撃面を閉じる。`delete-account` の認証要件
 *   (password + recovery code) と対称性を取る。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod/v4';
import { compare } from 'bcryptjs';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { disableMfa, verifyTotp, MfaLockedError } from '@/services/mfa.service';
import { recordAuthEvent } from '@/services/auth-event.service';

const disableMfaSchema = z.object({
  currentPassword: z.string().min(1, '現在のパスワードを入力してください'),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  // 2026-05-09 (#11): プラットフォーム運営者 (super_admin) のみ MFA 必須を維持。
  if (user.systemRole === 'super_admin') {
    const t = await getTranslations('message');
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: t('cannotDisableAdminMfa') } },
      { status: 403 },
    );
  }

  // B-5: パスワード + TOTP の再認証
  const body = await req.json().catch(() => null);
  const parsed = disableMfaSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true, mfaEnabled: true, tenantId: true },
  });
  if (!dbUser) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }

  // パスワード検証
  const isPasswordValid = await compare(parsed.data.currentPassword, dbUser.passwordHash);
  if (!isPasswordValid) {
    await recordAuthEvent({
      eventType: 'login_failure',
      tenantId: dbUser.tenantId,
      userId: user.id,
      detail: { reason: 'mfa_disable_invalid_password' },
    });
    return NextResponse.json(
      { error: { code: 'INVALID_CREDENTIALS', message: 'パスワードが正しくありません' } },
      { status: 401 },
    );
  }

  // 現 MFA 有効なら TOTP も検証 (セッション盗難 + パスワード漏洩同時時の防御)
  if (dbUser.mfaEnabled) {
    if (!parsed.data.totpCode) {
      return NextResponse.json(
        { error: { code: 'TOTP_REQUIRED', message: '現在の MFA コードを入力してください' } },
        { status: 400 },
      );
    }
    try {
      const valid = await verifyTotp(user.id, parsed.data.totpCode);
      if (!valid) {
        return NextResponse.json(
          { error: { code: 'INVALID_TOTP', message: 'MFA コードが正しくありません' } },
          { status: 401 },
        );
      }
    } catch (e) {
      if (e instanceof MfaLockedError) {
        return NextResponse.json(
          { error: { code: 'MFA_LOCKED', message: 'MFA 検証が一時的にロックされています' } },
          { status: 429 },
        );
      }
      throw e;
    }
  }

  await disableMfa(user.id);
  return NextResponse.json({ data: { success: true } });
}
