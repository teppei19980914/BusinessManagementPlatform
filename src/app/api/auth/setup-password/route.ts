import { NextRequest, NextResponse } from 'next/server';
import { hash } from 'bcryptjs';
import { setupPasswordSchema } from '@/lib/validators/auth';
import { setupPassword, validateToken } from '@/services/email-verification.service';
import { recordAuthEvent } from '@/services/auth-event.service';
import { BCRYPT_COST } from '@/config';

/**
 * GET: トークンの有効性を検証する（画面初期表示用）
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');

  if (!token) {
    return NextResponse.json(
      { error: { code: 'INVALID_TOKEN', message: '無効なリンクです' } },
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
 */
export async function POST(req: NextRequest) {
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
    data: { recoveryCodes: result.recoveryCodes },
  });
}
