/**
 * PATCH /api/admin/users/[userId] - ユーザ編集 (氏名 / ロール / 有効状態)
 *
 * 役割:
 *   システム管理者がユーザの氏名・システムロール・isActive (有効/無効) を更新する。
 *   isActive=false にすると当該ユーザは即時ログイン不可となる (中間状態あり)。
 *
 * 認可: requireAdmin (システム管理者のみ)
 * 監査: audit_logs (action=UPDATE, entityType=user) に before/after 記録。
 *
 * 関連:
 *   - DESIGN.md §9 (アカウント管理 / 無効化)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { updateUser } from '@/services/user.service';
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
        { error: { code: 'FORBIDDEN', message: '自分自身のロールは変更できません' } },
        { status: 403 },
      );
    }
    throw e;
  }
}
