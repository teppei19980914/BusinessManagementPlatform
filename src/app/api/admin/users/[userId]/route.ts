/**
 * PATCH  /api/admin/users/[userId] - ユーザ編集 (氏名 / ロール / 有効状態)
 * DELETE /api/admin/users/[userId] - ユーザ削除 (論理削除 + ProjectMember カスケード) (PR #89)
 *
 * 役割:
 *   システム管理者がユーザの氏名・システムロール・isActive (有効/無効) を更新する。
 *   isActive=false にすると当該ユーザは即時ログイン不可となる (中間状態あり)。
 *   DELETE は論理削除で、deletedAt セット + ProjectMember / Session / RecoveryCode 等を
 *   物理削除する (deleteUser 参照)。
 *
 * 認可: requireAdmin (システム管理者のみ)
 * 監査: audit_logs に before/after 記録。
 *
 * 関連:
 *   - DESIGN.md §9 (アカウント管理 / 無効化)
 *   - user.service.ts deleteUser (削除カスケード仕様)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod/v4';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { updateUser, deleteUser } from '@/services/user.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

const updateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  systemRole: z.enum(['admin', 'general']).optional(),
  isActive: z.boolean().optional(),
});

/**
 * ユーザ情報の編集 (PR #59 Req 3: 行クリック編集ポップアップ経由)。
 * 認可: システム管理者のみ。
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbiddenAdmin = requireAdmin(user);
  if (forbiddenAdmin) return forbiddenAdmin;

  const { userId } = await params;
  const t = await getTranslations('message');
  const body = await req.json();
  const parsed = updateUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  try {
    const updated = await updateUser(userId, parsed.data, user.id);
    await recordAuditLog({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'user',
      entityId: userId,
      afterValue: sanitizeForAudit(updated as unknown as Record<string, unknown>),
    });
    return NextResponse.json({ data: updated });
  } catch (e) {
    if (e instanceof Error && e.message === 'CANNOT_CHANGE_OWN_ROLE') {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: t('cannotChangeOwnRole') } },
        { status: 403 },
      );
    }
    throw e;
  }
}

/**
 * ユーザ削除 (PR #89)。
 * 論理削除 (deletedAt セット) + ProjectMember / Session / RecoveryCode 等を物理削除。
 * Task.assigneeId / Risk.reporterId 等の scalar 参照は残す (履歴保全)。
 * 自分自身の削除は不可。
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  const forbiddenAdmin = requireAdmin(user);
  if (forbiddenAdmin) return forbiddenAdmin;

  const { userId } = await params;
  const t = await getTranslations('message');

  try {
    const result = await deleteUser(userId, user.id);
    await recordAuditLog({
      userId: user.id,
      action: 'DELETE',
      entityType: 'user',
      entityId: userId,
      afterValue: {
        deletedUserId: result.deletedUserId,
        removedMemberships: result.removedMemberships,
      },
    });
    return NextResponse.json({ data: { success: true, ...result } });
  } catch (e) {
    if (e instanceof Error && e.message === 'CANNOT_DELETE_SELF') {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: t('cannotDeleteSelf') } },
        { status: 403 },
      );
    }
    if (e instanceof Error && e.message === 'NOT_FOUND') {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: t('userNotFoundOrDeleted') } },
        { status: 404 },
      );
    }
    throw e;
  }
}
