/**
 * POST /api/auth/setup-mfa-initial - admin 初期セットアップの最終段階 (PR #91)
 *
 * 役割:
 *   admin ユーザの初期セットアップフロー第 2 段階。
 *   setup-password で生成・保存された MFA シークレットに対して、
 *   ユーザが認証アプリで生成した 6 桁 TOTP を検証する。
 *   検証成功時にアカウント有効化 (isActive=true, deletedAt=null, mfaEnabled=true) される。
 *
 * 認可:
 *   セッション Cookie を持たない (まだログインできないフロー途中) ため、
 *   email_verification_token の保有 + 該当ユーザの mfaSecretEncrypted 存在で
 *   正当性を保証する。middleware の PUBLIC_PATHS に本エンドポイントを追加する。
 *
 * 関連:
 *   - SPECIFICATION.md §13.3 / §13.8 (admin MFA 必須化、PR #91)
 *   - email-verification.service.ts setupInitialMfa (ビジネスロジック)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod/v4';
import { setupInitialMfa } from '@/services/email-verification.service';
import { recordAuthEvent } from '@/services/auth-event.service';

const schema = z.object({
  token: z.string().min(1),
  code: z.string().length(6),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const t = await getTranslations('message');
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: t('mfaCodeRequired') } },
      { status: 400 },
    );
  }

  const result = await setupInitialMfa(parsed.data.token, parsed.data.code);
  if (!result.success) {
    return NextResponse.json(
      { error: { code: 'MFA_SETUP_FAILED', message: result.error } },
      { status: 400 },
    );
  }

  await recordAuthEvent({
    eventType: 'password_change',
    detail: { action: 'initial_mfa_enabled' },
  });

  return NextResponse.json({ data: { success: true } });
}
