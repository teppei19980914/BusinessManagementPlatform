/**
 * POST /api/auth/reset-password - パスワードリセット (2 段階)
 *
 * 役割:
 *   パスワードを忘れたユーザの自己リセットフロー (公開エンドポイント、未認証アクセス可)。
 *   - Step 1: メールアドレス + リカバリーコードで本人確認 → リセットトークン発行
 *   - Step 2: トークン + 新パスワードでパスワード再設定
 *
 *   2 段階に分けることで、リセットトークンの有効期限 (短時間) によるリスク低減と、
 *   平文パスワードを 1 リクエストに含めない設計を両立する。
 *
 * 認可:
 *   未認証アクセス可 (src/config/routes.ts の PUBLIC_PATHS に含まれる)。
 *   本人確認はリカバリーコードのみで行うため、コード漏洩リスクに注意。
 *
 * 監査: auth_event_logs に password_reset_requested / password_reset_completed を記録。
 *
 * 関連:
 *   - DESIGN.md §9.7 (パスワードリセット / リカバリーコード方式)
 *   - src/config/security.ts (PASSWORD_RESET_TOKEN_EXPIRY_MINUTES)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod/v4';
import { passwordSchema } from '@/lib/validators/auth';
import { verifyAndIssueResetToken, resetPassword } from '@/services/password-reset.service';
// PR #198: 公開認証エンドポイントのブルートフォース防御 (CWE-307)
import { applyRateLimit } from '@/lib/rate-limit';

const verifySchema = z.object({
  email: z.email(),
  recoveryCode: z.string().min(1),
});

const resetSchema = z.object({
  token: z.string().min(1),
  newPassword: passwordSchema,
});

export async function POST(req: NextRequest) {
  // PR #198: 同一 IP からのブルートフォース防御 (CWE-307)。閾値超過は 429 を返す。
  const limited = applyRateLimit(req, { key: 'reset-password' });
  if (limited) return limited;

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

  const t = await getTranslations('message');
  return NextResponse.json(
    { error: { code: 'VALIDATION_ERROR', message: t('invalidRequest') } },
    { status: 400 },
  );
}
