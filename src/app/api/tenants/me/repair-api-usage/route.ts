/**
 * POST /api/tenants/me/repair-api-usage (PR-V8.1 / 2026-05-19)
 *
 * テナント管理者が **自テナント** の `Tenant.currentMonthApiCallCount/CostJpy` を
 * ApiCallLog SUM (真値) で上書きする。
 *
 * 背景:
 *   ★請求 invariant (事業継続性の根本)★ により、テナント管理者画面とシステム管理者画面で
 *   表示が乖離してはならない。super_admin の介入を待たずテナント管理者自身が修復できる
 *   ようにすることで、drift の即時解消を可能にする。
 *
 * 認可: admin (テナント管理者) または super_admin。
 *   **テナント越境防止 (severity-1 個人情報漏洩リスク予防)**:
 *     - URL に tenantId を一切受けない (= 仕組み的に他テナントへの操作不能)
 *     - `session.user.tenantId` を強制的に使用
 *     - 自テナント以外への操作は構造的に発生不可能
 *
 * 監査: `repairTenantApiUsage` が内部で audit_log を 1 transaction で記録 (operation='repair-api-usage')。
 *
 * 関連:
 *   - service: src/services/api-usage-recalc.service.ts:repairTenantApiUsage
 *   - super_admin 版: src/app/api/admin/super/tenants/[id]/repair-api-usage/route.ts
 *   - UI: src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx の RepairOwnDriftButton
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isAdminOrAbove } from '@/lib/permissions/role';
import { repairTenantApiUsage } from '@/services/api-usage-recalc.service';

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

  // 自テナント分の counter を ApiCallLog SUM で上書き + audit_log を 1 transaction で記録
  const result = await repairTenantApiUsage(tenantId, user.id);

  if (result === null) {
    return NextResponse.json(
      { error: { code: 'TENANT_NOT_FOUND', message: 'テナントが見つかりません' } },
      { status: 404 },
    );
  }

  return NextResponse.json({ data: result });
}
