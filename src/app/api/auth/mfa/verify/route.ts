/**
 * POST /api/auth/mfa/verify - ログイン時 MFA 検証 (TOTP もしくはリカバリーコード)
 *
 * 役割:
 *   MFA 有効ユーザがパスワード認証通過後に呼ぶエンドポイント。TOTP コードか
 *   リカバリーコードのいずれかで検証成功すると、JWT 上の mfaVerified=true に
 *   更新され保護領域へアクセス可能になる。リカバリーコードは使用後に失効する。
 *
 * 認可:
 *   `mfaPendingPaths` (src/config/routes.ts) に含まれるため認証ミドルウェアを通過する。
 *   ただしセッションは確立済 (パスワード認証済) でないと userId が一致しない。
 *
 * 監査: auth_event_logs に mfa_verified / mfa_failure / recovery_code_used を記録。
 *
 * 関連:
 *   - DESIGN.md §9.5 (MFA 設計)
 *   - PR #67 (MFA ログイン強化)
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyTotp } from '@/services/mfa.service';
import { prisma } from '@/lib/db';
import { compare } from 'bcryptjs';
import { z } from 'zod/v4';
import { auth } from '@/lib/auth';

const totpSchema = z.object({ userId: z.string().uuid(), code: z.string().length(6) });
const recoverySchema = z.object({ userId: z.string().uuid(), recoveryCode: z.string().min(1) });

export async function POST(req: NextRequest) {
  // PR #67: セッションに紐付く userId のみを検証対象に制限し、他人の TOTP 検証を防ぐ
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }
  const body = await req.json();
  if (body?.userId && body.userId !== session.user.id) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'セッションユーザと一致しません' } },
      { status: 403 },
    );
  }

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
