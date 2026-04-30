/**
 * PATCH  /api/comments/[id] - コメント本文を更新
 * DELETE /api/comments/[id] - コメントを論理削除
 *
 * 役割:
 *   既存コメントの編集 / 削除 (PR #199)。
 *
 * 認可:
 *   投稿者本人 OR システム管理者 (要件 Q5)。
 *   親エンティティに対する権限の有無に依らず、誤投稿の救済のため admin は常に介入可。
 *
 * 関連:
 *   - DESIGN.md コメント機能節
 *   - src/services/comment.service.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { updateCommentSchema } from '@/lib/validators/comment';
import {
  deleteComment,
  getComment,
  updateComment,
} from '@/services/comment.service';
import { recordAuditLog } from '@/services/audit.service';

async function notFound() {
  const t = await getTranslations('message');
  return NextResponse.json(
    { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
    { status: 404 },
  );
}

async function forbidden() {
  const t = await getTranslations('message');
  return NextResponse.json(
    { error: { code: 'FORBIDDEN', message: t('forbidden') } },
    { status: 403 },
  );
}

/** 投稿者本人 OR admin かを判定する。 */
function canMutate(
  user: { id: string; systemRole: string },
  comment: { userId: string },
): boolean {
  return user.systemRole === 'admin' || comment.userId === user.id;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const existing = await getComment(id);
  if (!existing) return notFound();

  if (!canMutate(user, existing)) return forbidden();

  const body = await req.json();
  const parsed = updateCommentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const updated = await updateComment(id, parsed.data.content);

  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'comment',
    entityId: id,
  });

  return NextResponse.json({ data: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const existing = await getComment(id);
  if (!existing) return notFound();

  if (!canMutate(user, existing)) return forbidden();

  await deleteComment(id);

  await recordAuditLog({
    userId: user.id,
    action: 'DELETE',
    entityType: 'comment',
    entityId: id,
  });

  return NextResponse.json({ data: { success: true } });
}
