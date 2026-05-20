/**
 * DELETE /api/retrospectives/[retroId] - 振り返り論理削除 (全振り返り画面経由、admin only)
 *
 * 認可 (feat/crud-permission-redesign, 2026-05-20 新設):
 *   context='global' (admin only)。「全振り返り」画面からの管理削除のみを許可。
 *   ○○一覧経由の作成者本人削除は /api/projects/[id]/retrospectives/[retroId] DELETE を使う。
 *
 * 監査: audit_logs に DELETE を記録。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { getRetrospective, deleteRetrospective } from '@/services/retrospective.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ retroId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { retroId } = await params;
  const t = await getTranslations('message');
  const existing = await getRetrospective(retroId, undefined, undefined, user.tenantId);

  if (!existing) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }

  try {
    await deleteRetrospective(retroId, user.id, user.systemRole, user.tenantId, 'global');
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
    tenantId: user.tenantId,
    userId: user.id,
    action: 'DELETE',
    entityType: 'retrospective',
    entityId: retroId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: { success: true } });
}
