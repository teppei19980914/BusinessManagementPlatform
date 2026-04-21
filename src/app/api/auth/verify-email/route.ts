/**
 * GET /api/auth/verify-email?token=... - メール検証トークン検証
 *
 * 役割:
 *   管理者発行のユーザ宛検証メールに含まれるリンク先。トークンを検証し、
 *   検証成功時はユーザ詳細表示画面 (/setup-password) へ誘導する判断材料を返す。
 *
 * 認可: 未認証アクセス可 (PUBLIC_PATHS 経由)
 * 監査: auth_event_logs (eventType=email_verified) を記録。
 *
 * 関連:
 *   - DESIGN.md §9 (新規発行フロー / メール検証)
 *   - src/config/security.ts (EMAIL_VERIFICATION_TOKEN_EXPIRY_HOURS)
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyEmail } from '@/services/email-verification.service';
import { recordAuthEvent } from '@/services/auth-event.service';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');

  if (!token) {
    return NextResponse.redirect(new URL('/login?error=invalid_token', req.nextUrl.origin));
  }

  const result = await verifyEmail(token);

  if (!result.success) {
    const errorParam = encodeURIComponent(result.error || 'verification_failed');
    return NextResponse.redirect(
      new URL(`/login?error=${errorParam}`, req.nextUrl.origin),
    );
  }

  await recordAuthEvent({
    eventType: 'account_created',
    detail: { action: 'email_verified' },
  });

  return NextResponse.redirect(
    new URL('/login?verified=true', req.nextUrl.origin),
  );
}
