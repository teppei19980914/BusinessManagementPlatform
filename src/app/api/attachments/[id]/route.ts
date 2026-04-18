import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { checkMembership } from '@/lib/permissions';
import { updateAttachmentSchema } from '@/lib/validators/attachment';
import type { AttachmentEntityType } from '@/lib/validators/attachment';
import {
  deleteAttachment,
  getAttachment,
  resolveProjectIds,
  updateAttachment,
} from '@/services/attachment.service';
import { recordAuditLog } from '@/services/audit.service';

/**
 * 対象添付の親エンティティをたどり、リクエストユーザが権限を持つかを確認する。
 */
async function authorizeForAttachment(
  user: { id: string; systemRole: string },
  entityType: AttachmentEntityType,
  entityId: string,
): Promise<NextResponse | null> {
  if (user.systemRole === 'admin') return null;

  const projectIds = await resolveProjectIds(entityType, entityId);
  if (projectIds === null) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }
  if (projectIds.length === 0) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'この操作を実行する権限がありません' } },
      { status: 403 },
    );
  }
  for (const pid of projectIds) {
    const membership = await checkMembership(pid, user.id, user.systemRole);
    if (membership.isMember) return null;
  }
  return NextResponse.json(
    { error: { code: 'FORBIDDEN', message: 'この操作を実行する権限がありません' } },
    { status: 403 },
  );
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const existing = await getAttachment(id);
  if (!existing) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }

  const forbidden = await authorizeForAttachment(
    user,
    existing.entityType as AttachmentEntityType,
    existing.entityId,
  );
  if (forbidden) return forbidden;

  const body = await req.json();
  const parsed = updateAttachmentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const updated = await updateAttachment(id, parsed.data);

  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'attachment',
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
  const existing = await getAttachment(id);
  if (!existing) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } },
      { status: 404 },
    );
  }

  const forbidden = await authorizeForAttachment(
    user,
    existing.entityType as AttachmentEntityType,
    existing.entityId,
  );
  if (forbidden) return forbidden;

  await deleteAttachment(id);

  await recordAuditLog({
    userId: user.id,
    action: 'DELETE',
    entityType: 'attachment',
    entityId: id,
  });

  return NextResponse.json({ data: { success: true } });
}
