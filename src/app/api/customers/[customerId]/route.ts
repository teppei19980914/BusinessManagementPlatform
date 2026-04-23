/**
 * GET    /api/customers/[customerId]  - 顧客詳細取得 (admin 限定)
 * PATCH  /api/customers/[customerId]  - 顧客更新 (admin 限定)
 * DELETE /api/customers/[customerId]  - 顧客物理削除 (admin 限定、active Project 紐付きなし時のみ)
 *
 * 認可: すべて systemRole='admin' のみ。
 *
 * 監査:
 *   - PATCH: audit_logs (action=UPDATE, entityType=customer) に beforeValue / afterValue 記録
 *   - DELETE: audit_logs (action=DELETE, entityType=customer) に beforeValue 記録
 *
 * 削除仕様 (PR #111-1):
 *   - active Project (deletedAt IS NULL) が 1 件でも紐付けば 409 Conflict で拒否
 *   - カスケード削除は PR #111-2 で別エンドポイント (`/api/customers/[id]/cascade`) として実装予定
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { updateCustomerSchema } from '@/lib/validators/customer';
import {
  getCustomer,
  updateCustomer,
  deleteCustomer,
} from '@/services/customer.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

function forbidden(): NextResponse {
  return NextResponse.json(
    { error: { code: 'FORBIDDEN', message: 'この操作を実行する権限がありません' } },
    { status: 403 },
  );
}

function notFound(): NextResponse {
  return NextResponse.json(
    { error: { code: 'NOT_FOUND', message: '顧客が見つかりません' } },
    { status: 404 },
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ customerId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (user.systemRole !== 'admin') return forbidden();

  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return notFound();

  return NextResponse.json({ data: customer });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ customerId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (user.systemRole !== 'admin') return forbidden();

  const { customerId } = await params;

  const body = await req.json();
  const parsed = updateCustomerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } },
      { status: 400 },
    );
  }

  const before = await getCustomer(customerId);
  if (!before) return notFound();

  const updated = await updateCustomer(customerId, parsed.data, user.id);
  if (!updated) return notFound();

  await recordAuditLog({
    userId: user.id,
    action: 'UPDATE',
    entityType: 'customer',
    entityId: customerId,
    beforeValue: sanitizeForAudit(before as unknown as Record<string, unknown>),
    afterValue: sanitizeForAudit(updated as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ customerId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (user.systemRole !== 'admin') return forbidden();

  const { customerId } = await params;
  const before = await getCustomer(customerId);
  if (!before) return notFound();

  const result = await deleteCustomer(customerId);

  if (!result.ok && result.reason === 'not_found') {
    return notFound();
  }
  if (!result.ok && result.reason === 'has_active_projects') {
    return NextResponse.json(
      {
        error: {
          code: 'CONFLICT',
          message: `この顧客には active なプロジェクトが ${result.activeProjectCount} 件紐付いています。先にプロジェクトを削除してください (カスケード削除は PR #111-2 で提供予定)。`,
          activeProjectCount: result.activeProjectCount,
        },
      },
      { status: 409 },
    );
  }

  await recordAuditLog({
    userId: user.id,
    action: 'DELETE',
    entityType: 'customer',
    entityId: customerId,
    beforeValue: sanitizeForAudit(before as unknown as Record<string, unknown>),
  });

  return NextResponse.json({ data: { id: customerId } });
}
