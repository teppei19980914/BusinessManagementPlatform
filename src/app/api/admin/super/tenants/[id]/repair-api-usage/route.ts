/**
 * POST /api/admin/super/tenants/[id]/repair-api-usage (PR-V8 / 2026-05-19)
 *
 * super_admin が特定テナントの `Tenant.currentMonthApiCallCount/CostJpy` を
 * `ApiCallLog` SUM で上書きする (= 破壊的修復操作)。
 *
 * /admin/super/diagnostics の drift カード「修復する」ボタンから呼ばれる。
 *
 * 認可: super_admin role 必須。
 *   テナント分離: URL params の id は **super_admin の操作対象テナント** であり、
 *   super_admin は全テナント横断アクセス権を持つため、ここでは id をそのまま採用する。
 *
 * 監査: `repairTenantApiUsage` 内部で audit_log を 1 transaction で記録する。
 *
 * 関連:
 *   - service: src/services/api-usage-recalc.service.ts:repairTenantApiUsage
 *   - UI: src/app/(dashboard)/admin/super/diagnostics/repair-drift-button.tsx
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { repairTenantApiUsage } from '@/services/api-usage-recalc.service';

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

  // repairTenantApiUsage に actorUserId を渡すと audit_log を transaction で記録する
  const result = await repairTenantApiUsage(id, user.id);

  if (result === null) {
    return NextResponse.json(
      { error: { code: 'TENANT_NOT_FOUND', message: 'テナントが見つかりません' } },
      { status: 404 },
    );
  }

  return NextResponse.json({ data: result });
}
