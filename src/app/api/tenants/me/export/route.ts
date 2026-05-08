/**
 * GET /api/tenants/me/export (P-C / 2026-05-08)
 *
 * テナント管理者が自テナントの全業務データを ZIP でエクスポートする。
 *
 * 認可:
 *   - admin role 必須 (general / super_admin はアクセス不可)
 *   - 自テナントの tenantId のみ対象 (= 他テナントは見えない)
 *
 * P-C 仕様 (2026-05-08): Beginner プラン期限切れテナントもエクスポートは可。
 *   middleware は GET method を弾かないため、自動的に許可される。
 *
 * 関連:
 *   - サービス: src/services/data-export.service.ts (exportTenantData)
 *   - UI: src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx (エクスポートボタン)
 */

import { NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { exportTenantData } from '@/services/data-export.service';

// 大量データのため動的レスポンス + Node runtime (jszip は Node 専用)
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  try {
    const result = await exportTenantData(user.tenantId);

    // Uint8Array は BodyInit に直接代入できないため Buffer 化 (Node runtime 想定)
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
