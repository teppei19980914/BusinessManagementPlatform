/**
 * POST /api/tenants/me/recalculate (2026-05-14)
 *
 * テナント管理者 (admin) が **自テナント** の DB 容量 + API 利用量を即時再集計する。
 * /settings/tenant の「再集計」ボタンで呼ばれる。
 *
 * 認可: admin (テナント管理者) または super_admin。
 *   **テナント越境防止 (severity-1 個人情報漏洩リスク予防)**:
 *     - URL に tenantId を一切受けない (= 仕組み的に他テナントへの操作不能)
 *     - `session.user.tenantId` を強制的に使用
 *     - super_admin の場合: 管理テナント所属なので「自テナント = management tenant」
 *       で動作する。super_admin が他テナントを再集計したい場合は
 *       `/api/admin/super/tenants/[id]/recalculate` を使うこと
 *
 * 関連:
 *   - サービス: src/services/tenant-storage.service.ts:updateStorageBytesUsedForTenant
 *   - サービス: src/services/api-usage-recalc.service.ts:reconcileTenantApiUsage
 *   - UI: src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isAdminOrAbove } from '@/lib/permissions/role';
import { updateStorageBytesUsedForTenant } from '@/services/tenant-storage.service';
import { reconcileTenantApiUsage } from '@/services/api-usage-recalc.service';
import { recordAuditLog } from '@/services/audit.service';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  // admin 以上 (tenant admin / super_admin)。general は弾く。
  if (!isAdminOrAbove(user)) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN' } },
      { status: 403 },
    );
  }

  // テナント越境防止: tenantId は **必ず session から取得**。URL params は受けない。
  const tenantId = user.tenantId;

  const [bytes, reconcile] = await Promise.all([
    updateStorageBytesUsedForTenant(tenantId),
    reconcileTenantApiUsage(tenantId),
  ]);

  if (bytes === null || reconcile === null) {
    // 自テナントが「不在」= deletedAt が立った直後 / DB 不整合。401 相当だが、
    // 既にセッションは有効なので 404 で返す (UX は同じ)。
    return NextResponse.json(
      { error: { code: 'TENANT_NOT_FOUND', message: 'テナントが見つかりません' } },
      { status: 404 },
    );
  }

  await recordAuditLog({
    tenantId,
    userId: user.id,
    action: 'UPDATE',
    entityType: 'tenant',
    entityId: tenantId,
    afterValue: {
      operation: 'recalculate-self',
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
