import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { hash } from 'bcryptjs';
import { setupPasswordSchema } from '@/lib/validators/auth';
import { setupPassword, validateToken } from '@/services/email-verification.service';
import { recordAuthEvent } from '@/services/auth-event.service';
import { BCRYPT_COST } from '@/config';
// PR #198: 公開認証エンドポイントのブルートフォース防御 (CWE-307)
import { applyRateLimit } from '@/lib/rate-limit';

/**
 * GET: トークンの有効性を検証する（画面初期表示用）
 */
export async function GET(req: NextRequest) {
  // PR #198: トークン総当たり試行を抑制
  const limited = applyRateLimit(req, { key: 'setup-password-validate' });
  if (limited) return limited;

  const token = req.nextUrl.searchParams.get('token');

  if (!token) {
    const tAuth = await getTranslations('auth');
    return NextResponse.json(
      { error: { code: 'INVALID_TOKEN', message: tAuth('invalidLink') } },
      { status: 400 },
    );
  }

  const result = await validateToken(token);

  if (!result.valid) {
    return NextResponse.json(
      { error: { code: 'INVALID_TOKEN', message: result.error } },
      { status: 400 },
    );
  }

  return NextResponse.json({ data: { valid: true } });
}

/**
 * POST: パスワード設定 + アカウント有効化
 *
 * PR #91: admin ユーザは本エンドポイントでは **有効化せず**、MFA シークレットを
 *   生成して返す。UI は続いて MFA 登録ステップへ進み、
 *   `/api/auth/setup-mfa-initial` で TOTP 検証成功時に初めて有効化される。
 *
 * 応答:
 *   - general: { recoveryCodes }
 *   - admin  : { recoveryCodes, requiresMfa: true, mfa: { otpauthUri, qrCodeDataUrl } }
 */
export async function POST(req: NextRequest) {
  // PR #198: トークン + パスワード送信のブルートフォース防御
  const limited = applyRateLimit(req, { key: 'setup-password' });
  if (limited) return limited;

  const body = await req.json();
  const parsed = setupPasswordSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const passwordHash = await hash(parsed.data.password, BCRYPT_COST);
  const result = await setupPassword(parsed.data.token, passwordHash);

  if (!result.success) {
    return NextResponse.json(
      { error: { code: 'SETUP_FAILED', message: result.error } },
      { status: 400 },
    );
  }

  await recordAuthEvent({
    eventType: 'password_change',
    detail: { action: 'initial_password_set' },
  });

  return NextResponse.json({
    data: {
      recoveryCodes: result.recoveryCodes,
      requiresMfa: result.requiresMfa ?? false,
      mfa: result.mfa,
    },
  });
}
