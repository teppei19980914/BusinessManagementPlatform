/**
 * PATCH  /api/attachments/[id] - 添付編集 (表示名 / URL 等)
 * DELETE /api/attachments/[id] - 添付論理削除
 *
 * 役割:
 *   既存の添付 (attachments テーブルの 1 レコード) を編集または削除する。
 *
 * 認可:
 *   - memo entity の添付: authorizeMemoAttachment (作成者本人のみ編集/削除可)
 *   - その他 entity: checkMembership で該当プロジェクトのメンバー / admin のみ
 *
 * 関連:
 *   - DESIGN.md §22 (添付リンク設計)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { applySubjectRateLimit } from '@/lib/rate-limit';
import { checkMembership, isAdminOrAbove } from '@/lib/permissions';
import { updateAttachmentSchema } from '@/lib/validators/attachment';
import type { AttachmentEntityType } from '@/lib/validators/attachment';
import {
  authorizeMemoAttachment,
  deleteAttachment,
  getAttachment,
  isAttachmentTargetFullyClosed,
  resolveProjectIds,
  updateAttachment,
} from '@/services/attachment.service';
import { recordAuditLog } from '@/services/audit.service';
import { DELETE_API_RATE_LIMIT_PER_MIN } from '@/config/file-storage-pricing';

/**
 * 対象添付の親エンティティをたどり、リクエストユーザが権限を持つかを確認する。
 */
async function authorizeForAttachment(
  // 2026-05-09 feedback: severity-1 テナント越境対策で checkMembership に tenantId が必須化されたため、
  //   本ヘルパー引数の user にも tenantId を含める。getAuthenticatedUser() の戻り値と一致。
  user: { id: string; systemRole: string; tenantId: string },
  entityType: AttachmentEntityType,
  entityId: string,
): Promise<NextResponse | null> {
  const t = await getTranslations('message');
  // PR #70: memo は admin 特権なしの個人リソース。PATCH/DELETE は作成者のみ。
  if (entityType === 'memo') {
    const { ok, notFound } = await authorizeMemoAttachment(entityId, user.id, 'write', user.tenantId);
    if (notFound) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
        { status: 404 },
      );
    }
    if (!ok) {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: t('forbidden') } },
        { status: 403 },
      );
    }
    return null;
  }

  // 2026-06-12: クローズ済みPJ (読み取り専用) の資産の添付は編集・削除できない (admin 含む)。
  if (await isAttachmentTargetFullyClosed(entityType, entityId, user.tenantId)) {
    return NextResponse.json(
      {
        error: {
          code: 'PROJECT_CLOSED',
          message: 'このプロジェクトはクローズ済み (読み取り専用) のため添付を変更できません',
        },
      },
      { status: 403 },
    );
  }

  // feat/crud-permission-redesign (2026-05-20): super_admin も含めて短絡 (UI/API ヘルパ統一)
  if (isAdminOrAbove(user)) return null;

  const projectIds = await resolveProjectIds(entityType, entityId, user.tenantId);
  if (projectIds === null) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }
  if (projectIds.length === 0) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: t('forbidden') } },
      { status: 403 },
    );
  }
  for (const pid of projectIds) {
    const membership = await checkMembership(pid, user.id, user.systemRole, user.tenantId);
    if (membership.isMember) return null;
  }
  return NextResponse.json(
    { error: { code: 'FORBIDDEN', message: t('forbidden') } },
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
  const t = await getTranslations('message');
  const existing = await getAttachment(id, user.tenantId);
  if (!existing) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
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

  const updated = await updateAttachment(id, parsed.data, user.tenantId);

  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'UPDATE',
    entityType: 'attachment',
    entityId: id,
    // 2026-06-03: どの画面の リンク/ファイル が更新されたかを監査ログで示す (内容自体は記録しない)
    afterValue: {
      parentEntityType: updated.entityType,
      parentEntityId: updated.entityId,
      storageProvider: updated.storageProvider,
    },
  });

  return NextResponse.json({ data: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  // ADR-0021 §10.2.1: per-tenant delete API rate limit (100/min)
  const limited = applySubjectRateLimit({
    key: 'attachment-delete',
    subjectId: user.tenantId,
    max: DELETE_API_RATE_LIMIT_PER_MIN,
  });
  if (limited) return limited;

  const { id } = await params;
  const t = await getTranslations('message');
  const existing = await getAttachment(id, user.tenantId);
  if (!existing) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }

  const forbidden = await authorizeForAttachment(
    user,
    existing.entityType as AttachmentEntityType,
    existing.entityId,
  );
  if (forbidden) return forbidden;

  await deleteAttachment(id, user.tenantId);

  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'DELETE',
    entityType: 'attachment',
    entityId: id,
    // 2026-06-03: どの画面の リンク/ファイル が削除されたかを監査ログで示す (内容自体は記録しない)
    afterValue: {
      parentEntityType: existing.entityType,
      parentEntityId: existing.entityId,
      storageProvider: existing.storageProvider,
    },
  });

  return NextResponse.json({ data: { success: true } });
}
