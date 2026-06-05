/**
 * POST /api/admin/users/[userId]/cancel-invitation - 招待の取消 (テナント管理者)
 *
 * 役割:
 *   招待中 (まだパスワード未設定 = invitationAcceptedAt:null) のユーザの招待を取り消す。
 *   未受諾の招待は業務履歴を持たないため付随レコードごと物理削除し、Beginner 席数を解放する (案A)。
 *   受諾済みユーザには使えない (USER_NOT_FOUND) — その場合は無効化 (PATCH) / 削除 (DELETE) を使う。
 *
 * 認可: requireAdmin (システム管理者のみ) + requireSameTenantUser (越境遮断)
 * 監査: audit_logs (action=DELETE, entityType=user, afterValue.operation=cancel_invitation)
 *
 * 関連: src/services/user.service.ts (cancelInvitation)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin, requireSameTenantUser } from '@/lib/api-helpers';
import { cancelInvitation } from '@/services/user.service';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const { userId } = await params;
  const tenantViolation = await requireSameTenantUser(user, userId);
  if (tenantViolation) return tenantViolation;

  try {
    await cancelInvitation(userId, user.id, user.tenantId);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'UNKNOWN';
    if (message === 'USER_NOT_FOUND') {
      return NextResponse.json(
        { error: { code: 'USER_NOT_FOUND', message: '招待中のユーザが見つかりません (既に受諾済みの可能性があります)' } },
        { status: 404 },
      );
    }
    throw e;
  }

  return NextResponse.json({ data: { success: true } });
}
