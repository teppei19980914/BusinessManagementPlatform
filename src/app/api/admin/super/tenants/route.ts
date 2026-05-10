/**
 * POST /api/admin/super/tenants (P-G / 2026-05-08)
 *
 * super_admin がテナントを手動で払い出す API。
 * Body: TenantOnboardingInput (= 表示名 / slug / プラン / 請求先 4 項目 / 初期 admin)
 *
 * 認可: super_admin role 必須 (それ以外は 403)
 *
 * エラー:
 *   - 400: VALIDATION_ERROR
 *   - 401: 未認証
 *   - 403: super_admin 以外
 *   - 409: SLUG_CONFLICT / EMAIL_CONFLICT
 *   - 502: EMAIL_SEND_FAILED (テナント作成は compensating delete でロールバック済)
 *
 * 関連:
 *   - サービス: src/services/tenant-onboarding.service.ts (createTenantBySuperAdmin)
 *   - UI: src/app/(dashboard)/admin/super/tenants/new/page.tsx
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import {
  createTenantBySuperAdmin,
  type TenantOnboardingFailure,
} from '@/services/tenant-onboarding.service';
import { recordAuditLog } from '@/services/audit.service';

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  if (!isSuperAdmin(user)) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN' } },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'リクエスト JSON が不正です' } },
      { status: 400 },
    );
  }

  const baseUrl = process.env.NEXTAUTH_URL || req.nextUrl.origin;
  const result = await createTenantBySuperAdmin(body, baseUrl);

  if (result.ok) {
    // 監査ログ: super_admin がテナント新規作成
    // Phase 2-10: tenantId は **新規作成された tenant の id** を使う (target tenant への操作として記録)
    await recordAuditLog({
      tenantId: result.tenantId,
      userId: user.id,
      action: 'CREATE',
      entityType: 'tenant',
      entityId: result.tenantId,
      afterValue: { tenantId: result.tenantId, initialAdminUserId: result.initialAdminUserId },
    });

    return NextResponse.json(
      { data: { tenantId: result.tenantId, initialAdminUserId: result.initialAdminUserId } },
      { status: 201 },
    );
  }

  return mapFailureToHttp(result);
}

function mapFailureToHttp(result: TenantOnboardingFailure): NextResponse {
  switch (result.reason) {
    case 'VALIDATION_ERROR':
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: result.message } },
        { status: 400 },
      );
    case 'SLUG_CONFLICT':
      return NextResponse.json(
        { error: { code: 'SLUG_CONFLICT', message: result.message } },
        { status: 409 },
      );
    case 'EMAIL_CONFLICT':
      return NextResponse.json(
        { error: { code: 'EMAIL_CONFLICT', message: result.message } },
        { status: 409 },
      );
    case 'EMAIL_SEND_FAILED':
      return NextResponse.json(
        { error: { code: 'EMAIL_SEND_FAILED', message: result.message } },
        { status: 502 },
      );
    case 'BEGINNER_NOT_AVAILABLE_FOR_RETURNING':
      return NextResponse.json(
        { error: { code: 'BEGINNER_NOT_AVAILABLE_FOR_RETURNING', message: result.message } },
        { status: 409 },
      );
  }
}
