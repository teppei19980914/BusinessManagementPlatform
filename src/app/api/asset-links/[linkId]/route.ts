/**
 * DELETE /api/asset-links/[linkId] - 手動リンクを削除
 *
 * 役割: v1.3.0 資産導線機能の手動リンク削除。
 * 認可: 作成者本人のみ削除可 (comments の canMutate と同方針、admin 救済なし)。
 *   存在しない/他テナント/作成者でない場合はいずれも 404 を返す
 *   (403 で「存在するが権限がない」ことを漏らさない、deleteAssetLink の方針)。
 * 監査: audit_logs (entityType='asset_link', action='DELETE') を記録。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { deleteAssetLink } from '@/services/asset-link.service';
import { recordAuditLog } from '@/services/audit.service';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ linkId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const { linkId } = await params;
  const deleted = await deleteAssetLink(linkId, user.id, user.tenantId);
  if (!deleted) {
    const t = await getTranslations('message');
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: t('notFoundTarget') } },
      { status: 404 },
    );
  }

  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'DELETE',
    entityType: 'asset_link',
    entityId: linkId,
  });

  return NextResponse.json({ data: { success: true } });
}
