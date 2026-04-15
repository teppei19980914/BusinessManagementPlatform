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
