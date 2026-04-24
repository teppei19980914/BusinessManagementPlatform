/**
 * POST /api/admin/users/[userId]/unlock - ロック解除 (パスワード + MFA 同時)
 *
 * 役割:
 *   システム管理者がアカウントを手動解除する。以下 2 系統をまとめてリセット:
 *     - パスワードログイン失敗 (failedLoginCount / lockedUntil / permanentLock)
 *     - MFA verify 失敗 (mfaFailedCount / mfaLockedUntil) — PR #116 で追加
 *   どちらか一方だけロック中でも、2 系統を同時にリセットする
 *   (admin の手動介入時点で「アクティブなアカウント」に戻す想定)。
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
import { unlockMfaByAdmin } from '@/services/mfa.service';
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

  // パスワードロックと MFA ロックを同時解除
  await unlockAccount(userId, user.id);
  await unlockMfaByAdmin(userId);

  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'user',
    entityId: userId,
    afterValue: {
      action: 'unlock',
      failedLoginCount: 0,
      permanentLock: false,
      mfaFailedCount: 0,
      mfaLockedUntil: null,
    },
  });

  return NextResponse.json({ data: { success: true } });
}
