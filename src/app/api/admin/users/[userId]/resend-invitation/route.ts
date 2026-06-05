/**
 * POST /api/admin/users/[userId]/resend-invitation - 招待メールの再送 (テナント管理者)
 *
 * 役割:
 *   招待中 (まだパスワード未設定 = invitationAcceptedAt:null) のユーザに、パスワード設定リンク付き
 *   招待メールを再送する。旧トークンは無効化され、新しいトークンが発行される。
 *   受諾済みユーザには再送しない (USER_NOT_FOUND)。
 *
 * 認可: requireAdmin (システム管理者のみ) + requireSameTenantUser (越境遮断)
 * 監査: audit_logs (action=UPDATE, entityType=user, afterValue.operation=resend_invitation)
 *
 * 関連:
 *   - src/services/user.service.ts (resendInvitationByAdmin)
 *   - 公開セルフ再送は /api/auth/resend-verification (本ルートは管理者起動)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin, requireSameTenantUser } from '@/lib/api-helpers';
import { resendInvitationByAdmin } from '@/services/user.service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const { userId } = await params;
  const tenantViolation = await requireSameTenantUser(user, userId);
  if (tenantViolation) return tenantViolation;

  const baseUrl = process.env.NEXTAUTH_URL || req.nextUrl.origin;

  try {
    await resendInvitationByAdmin(userId, user.id, user.tenantId, baseUrl);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'UNKNOWN';
    if (message === 'USER_NOT_FOUND') {
      return NextResponse.json(
        { error: { code: 'USER_NOT_FOUND', message: '招待中のユーザが見つかりません (既に受諾済みの可能性があります)' } },
        { status: 404 },
      );
    }
    if (message === 'EMAIL_SEND_FAILED') {
      return NextResponse.json(
        { error: { code: 'EMAIL_SEND_FAILED', message: 'メール送信に失敗しました。時間をおいて再度お試しください' } },
        { status: 502 },
      );
    }
    throw e;
  }

  return NextResponse.json({ data: { success: true } });
}
