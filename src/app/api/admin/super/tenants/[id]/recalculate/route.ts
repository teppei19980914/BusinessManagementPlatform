/**
 * POST /api/admin/super/tenants/[id]/recalculate (2026-05-14)
 *
 * super_admin が特定テナントの DB 容量 + API 利用量を即時再集計する。
 * テナント詳細画面の「再集計」ボタンで呼ばれる。
 *
 * 認可: super_admin role 必須。
 *   テナント分離: URL params の id は **super_admin の操作対象テナント** であり、
 *   super_admin は全テナント横断アクセス権を持つため、ここでは id をそのまま採用する。
 *   ただし `updateStorageBytesUsedForTenant` 側で `deletedAt: null` フィルタを
 *   かけているため、削除済テナントへの操作は null 戻り値で弾かれる。
 *
 * 関連:
 *   - サービス: src/services/tenant-storage.service.ts:updateStorageBytesUsedForTenant
 *   - サービス: src/services/api-usage-recalc.service.ts:reconcileTenantApiUsage
 *   - UI: src/app/(dashboard)/admin/super/tenants/[id]/page.tsx
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { updateStorageBytesUsedForTenant } from '@/services/tenant-storage.service';
import { reconcileTenantApiUsage } from '@/services/api-usage-recalc.service';
import { recordAuditLog } from '@/services/audit.service';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  if (!isSuperAdmin(user)) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN' } },
      { status: 403 },
    );
  }

  const { id } = await params;

  const [bytes, reconcile] = await Promise.all([
    updateStorageBytesUsedForTenant(id),
    reconcileTenantApiUsage(id),
  ]);

  if (bytes === null || reconcile === null) {
    return NextResponse.json(
      { error: { code: 'TENANT_NOT_FOUND', message: 'テナントが見つかりません' } },
      { status: 404 },
    );
  }

  // 監査: super_admin が他テナントを再集計した = 監査対象 (代行操作)
  await recordAuditLog({
    tenantId: id,
    userId: user.id,
    action: 'UPDATE',
    entityType: 'tenant',
    entityId: id,
    afterValue: {
      operation: 'recalculate',
      storageBytes: Number(bytes),
      apiDriftRatio: reconcile.driftRatio,
      hasDrift: reconcile.hasDrift,
    },
  });

  return NextResponse.json({
    data: {
      storageBytesUsed: Number(bytes),
      apiUsage: reconcile,
    },
  });
}
