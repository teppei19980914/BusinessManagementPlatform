import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import {
  deleteRetrospective,
  getRetrospective,
  updateRetrospective,
} from '@/services/retrospective.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

/**
 * 振り返り更新。
 *
 * 2026-04-24: 認可は **作成者本人のみ**。admin であっても他人の振り返りは編集不可。
 * (管理業務は削除のみに限定する方針)
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; retroId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, retroId } = await params;
  const t = await getTranslations('message');

  const existing = await getRetrospective(retroId);
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }

  // プロジェクトアクセス自体は担保 (閉域プロジェクト状態などの制約を維持)
  const forbidden = await checkProjectPermission(user, projectId, 'project:read');
  if (forbidden) return forbidden;

  const body = await req.json();
  try {
    await updateRetrospective(retroId, body, user.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'FORBIDDEN') {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: t('creatorOnlyEdit') } },
        { status: 403 },
      );
    }
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    throw e;
  }

  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'retrospective',
    entityId: retroId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
    afterValue: sanitizeForAudit(body as Record<string, unknown>),
  });

  return NextResponse.json({ data: { success: true } });
}

/**
 * 振り返り削除エンドポイント。
 *
 * 2026-04-24: 認可は **作成者本人 OR admin**。admin は「全振り返り」からの管理削除を想定。
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; retroId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { projectId, retroId } = await params;
  const t = await getTranslations('message');

  const existing = await getRetrospective(retroId);
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }

  const forbidden = await checkProjectPermission(user, projectId, 'project:read');
  if (forbidden) return forbidden;

  try {
    await deleteRetrospective(retroId, user.id, user.systemRole);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'FORBIDDEN') {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: t('creatorOrAdminOnlyDelete') } },
        { status: 403 },
      );
    }
    if (msg === 'NOT_FOUND') {
      return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    throw e;
  }
  await recordAuditLog({
    userId: user.id,
    action: 'DELETE',
    entityType: 'retrospective',
    entityId: retroId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
  });
  return NextResponse.json({ data: { success: true } });
}
