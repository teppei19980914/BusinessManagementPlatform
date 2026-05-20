/**
 * DELETE /api/risks/[riskId] - リスク/課題論理削除 (全リスク/課題画面経由、admin only)
 *
 * 認可 (feat/crud-permission-redesign, 2026-05-20 新設):
 *   context='global' (admin only)。「全リスク/全課題」画面からの管理削除のみを許可。
 *   ○○一覧経由の作成者本人削除は /api/projects/[id]/risks/[riskId] DELETE を使う。
 *
 * 旧仕様: 横断画面の admin 削除も project 経路 (/api/projects/[id]/risks/[riskId] DELETE)
 *   を兼用していたが、UI=API 一致原則 (一覧経路 admin 削除 NG / 横断経路 admin 削除 OK)
 *   を実現するため経路を分離。Knowledge と対称の構造に。
 *
 * 監査: audit_logs に DELETE を記録。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { getRisk, deleteRisk } from '@/services/risk.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ riskId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { riskId } = await params;
  const t = await getTranslations('message');
  // 内部呼び出し (認可オフ) で生行を取得、tenant 越境は viewerTenantId で防御
  const existing = await getRisk(riskId, undefined, undefined, user.tenantId);

  if (!existing) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }

  try {
    await deleteRisk(riskId, user.id, user.systemRole, user.tenantId, 'global');
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
    entityType: existing.type === 'risk' ? 'risk' : 'issue',
    entityId: riskId,
    beforeValue: sanitizeForAudit(existing as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: { success: true } });
}
