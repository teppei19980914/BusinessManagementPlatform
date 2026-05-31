/**
 * GET  /api/customers  - 顧客一覧取得 (admin / super_admin 限定)
 * POST /api/customers  - 顧客新規作成 (admin / super_admin 限定)
 *
 * 認可:
 *   - GET / POST ともに systemRole='admin' または 'super_admin'
 *   - プロジェクト未所属の admin も操作可
 *   - super_admin の tenantId は MANAGEMENT_TENANT_ID なので、本 API 経由で管理テナントの
 *     シード Customer を CRUD できる (2026-05-14 追加)
 *
 * 監査: POST 時に audit_logs (action=CREATE, entityType=customer) を記録。
 *
 * 関連: PR #111-1 (顧客管理導入第 1 弾)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser, requireStorageQuotaForWrite } from '@/lib/api-helpers';
import { isAdminOrAbove } from '@/lib/permissions/role';
import { createCustomerSchema } from '@/lib/validators/customer';
import { listCustomers, createCustomer } from '@/services/customer.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

async function forbidden(): Promise<NextResponse> {
  const t = await getTranslations('message');
  return NextResponse.json(
    { error: { code: 'FORBIDDEN', message: t('forbidden') } },
    { status: 403 },
  );
}

export async function GET() {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (!isAdminOrAbove(user)) return await forbidden();

  const data = await listCustomers(user.tenantId);
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (!isAdminOrAbove(user)) return await forbidden();

  const body = await req.json();
  const parsed = createCustomerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  // PR-5 (2026-05-15): ストレージ容量 Pre-check
  const quotaErr = await requireStorageQuotaForWrite(
    user.tenantId,
    Buffer.byteLength(JSON.stringify(parsed.data), 'utf8'),
  );
  if (quotaErr) return quotaErr;

  const customer = await createCustomer(parsed.data, user.id, user.tenantId);

  await recordAuditLog({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'CREATE',
    entityType: 'customer',
    entityId: customer.id,
    afterValue: sanitizeForAudit(customer as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: customer }, { status: 201 });
}
