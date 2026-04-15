import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { passwordSchema } from '@/lib/validators/auth';
import { verifyAndIssueResetToken, resetPassword } from '@/services/password-reset.service';

const verifySchema = z.object({
  email: z.email(),
  recoveryCode: z.string().min(1),
});

const resetSchema = z.object({
  token: z.string().min(1),
  newPassword: passwordSchema,
});

export async function POST(req: NextRequest) {
  const body = await req.json();

  // ステップ1: メール + リカバリーコードで本人確認
  if (body.email && body.recoveryCode) {
    const parsed = verifySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
        { status: 400 },
      );
    }

    const result = await verifyAndIssueResetToken(parsed.data.email, parsed.data.recoveryCode);

    if (!result.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: result.error } },
        { status: 400 },
      );
    }

    return NextResponse.json({ data: { token: result.token } });
  }

  // ステップ2: トークン + 新パスワードでリセット
  if (body.token && body.newPassword) {
    const parsed = resetSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
        { status: 400 },
      );
    }

    const result = await resetPassword(parsed.data.token, parsed.data.newPassword);

    if (!result.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: result.error } },
        { status: 400 },
      );
    }

    return NextResponse.json({ data: { success: true } });
  }

  return NextResponse.json(
    { error: { code: 'VALIDATION_ERROR', message: '不正なリクエストです' } },
    { status: 400 },
  );
}
