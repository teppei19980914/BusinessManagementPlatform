/**
 * GET /api/admin/super/tenants/[id]/export (P-C / 2026-05-08)
 *
 * super_admin が任意テナントのデータを代行エクスポートする (顧客サポート用途)。
 *
 * 認可: super_admin role 必須
 *
 * 関連:
 *   - サービス: src/services/data-export.service.ts (exportTenantData)
 *   - UI: src/app/(dashboard)/admin/super/tenants/[id]/page.tsx (代行エクスポートボタン)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { exportTenantData } from '@/services/data-export.service';
import { recordAuditLog } from '@/services/audit.service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
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

  try {
    const result = await exportTenantData(id);

    // 監査ログ: super_admin が他テナントのデータを取得した = 監査対象
    // Phase 2-10 (2026-05-10): tenantId は **代行先のテナント** (= id) を使う。
    //   actor の super_admin は management tenant 所属だが、本ログは
    //   「target tenant に対する操作」として記録するのが意味的に正しい
    //   (= target tenant の admin は自分のテナントが代行されたことを監査可能)。
    await recordAuditLog({
      tenantId: id,
      userId: user.id,
      action: 'EXPORT',
      entityType: 'tenant',
      entityId: id,
      afterValue: { exportedAt: result.summary.exportedAt, counts: result.summary.counts },
    });

    return new NextResponse(Buffer.from(result.zipBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof Error && e.message === 'TENANT_NOT_FOUND') {
      return NextResponse.json(
        { error: { code: 'TENANT_NOT_FOUND', message: 'テナントが見つかりません' } },
        { status: 404 },
      );
    }
    throw e;
  }
}
