/**
 * POST /api/admin/users/[userId]/unlock - ロック解除
 *
 * 役割:
 *   ログイン失敗回数超過 (LOGIN_FAILURE_MAX) で一時/恒久ロックされたアカウントを
 *   システム管理者が手動解除する。failedLoginCount / lockedUntil / permanentLock を
 *   全てリセットして即ログイン可能にする。
 *
 * 認可: requireAdmin (システム管理者のみ)
 * 監査: audit_logs (action=UPDATE, entityType=user) に解除事象を記録。
 *
 * 関連:
 *   - DESIGN.md §9.4 (アカウントロック / 解除)
 *   - src/config/security.ts (LOGIN_FAILURE_MAX 等)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { unlockAccount } from '@/services/password.service';
import { recordAuditLog } from '@/services/audit.service';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  const { userId } = await params;

  await unlockAccount(userId, user.id);

  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'user',
    entityId: userId,
    afterValue: { action: 'unlock', failedLoginCount: 0, permanentLock: false },
  });

  return NextResponse.json({ data: { success: true } });
}
