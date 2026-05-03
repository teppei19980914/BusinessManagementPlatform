/**
 * PATCH  /api/comments/[id] - コメント本文を更新
 * DELETE /api/comments/[id] - コメントを論理削除
 *
 * 役割:
 *   既存コメントの編集 / 削除 (PR #199)。
 *
 * 認可:
 *   2026-05-01 (PR fix/visibility-auth-matrix): **投稿者本人のみ** (admin 不可)。
 *   旧仕様 (PR #199) の admin 救済は外し、誤投稿の救済は entity ごとカスケード削除に委ねる。
 *   コメント主が削除/編集できない孤児コメントは、entity 側を delete することで cascade で消える。
 *
 * 関連:
 *   - DESIGN.md コメント機能節
 *   - src/services/comment.service.ts
 *   - DEVELOPER_GUIDE §5.51 (本仕様の根拠)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { updateCommentSchema } from '@/lib/validators/comment';
import type { CommentEntityType } from '@/lib/validators/comment';
import {
  deleteComment,
  getComment,
  updateComment,
} from '@/services/comment.service';
import { recordAuditLog } from '@/services/audit.service';
import { validateMentionsForEntity } from '@/services/mention.service';
import { buildEntityCommentLink } from '@/lib/entity-link';

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

/**
 * 投稿者本人かを判定する。
 * 2026-05-01: admin 救済は外した (`systemRole` を引数から削除)。
 */
function canMutate(
  user: { id: string },
  comment: { userId: string },
): boolean {
  return comment.userId === user.id;
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

  // PR feat/comment-mentions: 編集時の mention diff (追加分のみ通知)
  const mentions = parsed.data.mentions;
  if (mentions && mentions.length > 0) {
    const v = validateMentionsForEntity(existing.entityType as CommentEntityType, mentions);
    if (!v.ok) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: v.reason } },
        { status: 400 },
      );
    }
  }
  const link = mentions
    ? await buildEntityCommentLink(existing.entityType as CommentEntityType, existing.entityId)
    : '';
  const updated = await updateComment(id, parsed.data.content, mentions, user.name, link);

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
