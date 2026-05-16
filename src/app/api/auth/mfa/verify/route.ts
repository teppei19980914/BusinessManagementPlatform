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
 * fix/jwt-resign-for-netlify (2026-05-18):
 *   旧仕様はクライアント側の `useSession().update({ mfaVerified: true })` で JWT 更新していたが、
 *   NextAuth v5 0-beta.31 + @netlify/plugin-nextjs では `POST /api/auth/session` の
 *   Set-Cookie がブラウザに反映されない事象を確認 (MFA 検証ループの原因)。
 *
 *   対応として本ルートが検証成功時に**直接 JWT を再署名して Set-Cookie する**ように変更。
 *   middleware の mfaPending 判定は新 JWT を読むため、副作用なく即時抜ける。
 *   詳細は src/lib/auth-jwt-helper.ts の docblock を参照。
 *
 * 関連:
 *   - DESIGN.md §9.5 (MFA 設計)
 *   - PR #67 (MFA ログイン強化)
 *   - KDD: docs/knowledge/KDD_PATTERNS.md "Netlify + NextAuth v5 Set-Cookie 不達"
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import {
  verifyTotp,
  resetMfaLockOnRecoveryCodeUse,
  MfaLockedError,
} from '@/services/mfa.service';
import { prisma } from '@/lib/db';
import { compare } from 'bcryptjs';
import { z } from 'zod/v4';
import { auth } from '@/lib/auth';
import { reissueAuthJwtOnResponse } from '@/lib/auth-jwt-helper';

const totpSchema = z.object({ userId: z.string().uuid(), code: z.string().length(6) });
const recoverySchema = z.object({ userId: z.string().uuid(), recoveryCode: z.string().min(1) });

export async function POST(req: NextRequest) {
  const t = await getTranslations('message');
  // PR #67: セッションに紐付く userId のみを検証対象に制限し、他人の TOTP 検証を防ぐ
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }
  const body = await req.json();
  if (body?.userId && body.userId !== session.user.id) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: t('mfaSessionMismatch') } },
      { status: 403 },
    );
  }

  // TOTP コード検証
  if (body.code) {
    const parsed = totpSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR' } }, { status: 400 });
    }

    // PR #116: ロック中は即 429 / 失敗カウント閾値到達時も 429
    let isValid = false;
    try {
      isValid = await verifyTotp(parsed.data.userId, parsed.data.code);
    } catch (e) {
      if (e instanceof MfaLockedError) {
        return NextResponse.json(
          {
            error: {
              code: 'MFA_LOCKED',
              message: t('mfaLockedDueToFailures'),
              lockedUntil: e.lockedUntil.toISOString(),
            },
          },
          { status: 429 },
        );
      }
      throw e;
    }
    if (!isValid) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: t('mfaCodeInvalid') } },
        { status: 400 },
      );
    }

    // fix/jwt-resign-for-netlify: 検証成功で JWT を mfaVerified=true に再署名 + Set-Cookie。
    // クライアントは update() を呼ばずに、本レスポンスの cookie だけで middleware を通過できる。
    const successResponse = NextResponse.json({ data: { success: true } });
    await reissueAuthJwtOnResponse(req, successResponse, { mfaVerified: true });
    return successResponse;
  }

  // リカバリーコードでのフォールバック
  if (body.recoveryCode) {
    const parsed = recoverySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR' } }, { status: 400 });
    }

    // PR #116: MFA ロック中でも recovery code 経路は通す (ロック解除の自己救済手段)
    const codes = await prisma.recoveryCode.findMany({
      where: { userId: parsed.data.userId, usedAt: null },
    });

    for (const code of codes) {
      const isMatch = await compare(parsed.data.recoveryCode, code.codeHash);
      if (isMatch) {
        await prisma.recoveryCode.update({ where: { id: code.id }, data: { usedAt: new Date() } });
        // PR #116: recovery code 使用成功で MFA ロック・失敗カウントを同時にリセット
        await resetMfaLockOnRecoveryCodeUse(parsed.data.userId);
        // fix/jwt-resign-for-netlify: recovery code 経路も同様に JWT 再署名
        const successResponse = NextResponse.json({ data: { success: true } });
        await reissueAuthJwtOnResponse(req, successResponse, { mfaVerified: true });
        return successResponse;
      }
    }

    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: t('mfaRecoveryCodeInvalid') } },
      { status: 400 },
    );
  }

  return NextResponse.json({ error: { code: 'VALIDATION_ERROR' } }, { status: 400 });
}
