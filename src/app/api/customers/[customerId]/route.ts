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
 * 削除仕様 (PR #111-2 更新):
 *   - デフォルト (?cascade 未指定 or false): active Project 紐付きがあれば 409 Conflict
 *   - ?cascade=true: 紐付く active Project を `deleteProjectCascade` で一括物理削除後に Customer 削除
 *     - 追加フラグ: cascadeRisks / cascadeIssues / cascadeRetros / cascadeKnowledge
 *       (細粒度確認ダイアログから渡される; 各 Project の deleteProjectCascade にそのまま渡る)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { updateCustomerSchema } from '@/lib/validators/customer';
import {
  getCustomer,
  updateCustomer,
  deleteCustomer,
  deleteCustomerCascade,
} from '@/services/customer.service';
import { recordAuditLog, sanitizeForAudit } from '@/services/audit.service';

async function forbidden(): Promise<NextResponse> {
  const t = await getTranslations('message');
  return NextResponse.json(
    { error: { code: 'FORBIDDEN', message: t('forbidden') } },
    { status: 403 },
  );
}

async function notFound(): Promise<NextResponse> {
  const t = await getTranslations('message');
  return NextResponse.json(
    { error: { code: 'NOT_FOUND', message: t('customerNotFound') } },
    { status: 404 },
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ customerId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (user.systemRole !== 'admin') return await forbidden();

  const { customerId } = await params;
  const customer = await getCustomer(customerId);
  if (!customer) return await notFound();

  return NextResponse.json({ data: customer });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ customerId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (user.systemRole !== 'admin') return await forbidden();

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
  if (!before) return await notFound();

  const updated = await updateCustomer(customerId, parsed.data, user.id);
  if (!updated) return await notFound();

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
  req: NextRequest,
  { params }: { params: Promise<{ customerId: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;
  if (user.systemRole !== 'admin') return await forbidden();

  const { customerId } = await params;
  const before = await getCustomer(customerId);
  if (!before) return await notFound();

  // PR #111-2: ?cascade=true で deleteCustomerCascade 経路に切り替え
  const { searchParams } = req.nextUrl;
  const cascade = searchParams.get('cascade') === 'true';

  if (cascade) {
    const result = await deleteCustomerCascade(customerId, {
      cascadeRisks: searchParams.get('cascadeRisks') === 'true',
      cascadeIssues: searchParams.get('cascadeIssues') === 'true',
      cascadeRetros: searchParams.get('cascadeRetros') === 'true',
      cascadeKnowledge: searchParams.get('cascadeKnowledge') === 'true',
    });
    if (!result.ok && result.reason === 'not_found') return await notFound();

    await recordAuditLog({
      userId: user.id,
      action: 'DELETE',
      entityType: 'customer',
      entityId: customerId,
      beforeValue: sanitizeForAudit(before as unknown as Record<string, unknown>),
    });
    return NextResponse.json({
      data: {
        id: customerId,
        cascade: true,
        ...(result.ok
          ? {
              projectsDeleted: result.projectsDeleted,
              risksDeleted: result.risksDeleted,
              issuesDeleted: result.issuesDeleted,
              retrospectivesDeleted: result.retrospectivesDeleted,
              knowledgeDeleted: result.knowledgeDeleted,
              knowledgeUnlinked: result.knowledgeUnlinked,
              attachmentsDeleted: result.attachmentsDeleted,
            }
          : {}),
      },
    });
  }

  const result = await deleteCustomer(customerId);

  if (!result.ok && result.reason === 'not_found') {
    return await notFound();
  }
  if (!result.ok && result.reason === 'has_active_projects') {
    return NextResponse.json(
      {
        error: {
          code: 'CONFLICT',
          message: `この顧客には active なプロジェクトが ${result.activeProjectCount} 件紐付いています。カスケード削除を使うか、先に個別にプロジェクトを削除してください。`,
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
