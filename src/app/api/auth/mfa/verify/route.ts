import { NextRequest, NextResponse } from 'next/server';
import { verifyTotp } from '@/services/mfa.service';
import { prisma } from '@/lib/db';
import { compare } from 'bcryptjs';
import { z } from 'zod/v4';

const totpSchema = z.object({ userId: z.string().uuid(), code: z.string().length(6) });
const recoverySchema = z.object({ userId: z.string().uuid(), recoveryCode: z.string().min(1) });

export async function POST(req: NextRequest) {
  const body = await req.json();

  // TOTP コード検証
  if (body.code) {
    const parsed = totpSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR' } }, { status: 400 });
    }

    const isValid = await verifyTotp(parsed.data.userId, parsed.data.code);
    if (!isValid) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: 'コードが正しくありません' } },
        { status: 400 },
      );
    }

    return NextResponse.json({ data: { success: true } });
  }

  // リカバリーコードでのフォールバック
  if (body.recoveryCode) {
    const parsed = recoverySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR' } }, { status: 400 });
    }

    const codes = await prisma.recoveryCode.findMany({
      where: { userId: parsed.data.userId, usedAt: null },
    });

    for (const code of codes) {
      const isMatch = await compare(parsed.data.recoveryCode, code.codeHash);
      if (isMatch) {
        await prisma.recoveryCode.update({ where: { id: code.id }, data: { usedAt: new Date() } });
        return NextResponse.json({ data: { success: true } });
      }
    }

    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'リカバリーコードが正しくありません' } },
      { status: 400 },
    );
  }

  return NextResponse.json({ error: { code: 'VALIDATION_ERROR' } }, { status: 400 });
}
