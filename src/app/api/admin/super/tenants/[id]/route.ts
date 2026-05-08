/**
 * DELETE /api/admin/super/tenants/[id] (P-A / 2026-05-08)
 *
 * 役割:
 *   super_admin (プラットフォーム運営者) が問題テナント (TOS 違反 / 課金未払等) を
 *   論理削除する。配下のユーザ・プロジェクト・ナレッジ等もカスケードで論理削除し、
 *   ログインや業務操作を即時遮断する。
 *
 * 認可:
 *   - super_admin role 必須 (それ以外は 403)
 *   - 管理テナント (MANAGEMENT_TENANT_ID) は削除禁止 (= 自爆防止)
 *
 * エラー:
 *   - 401: 未認証
 *   - 403: super_admin 以外 / 管理テナント削除試行
 *   - 404: テナント不在
 *   - 409: 既に削除済み
 *
 * 関連:
 *   - 計画: docs/roadmap/V1_FINAL_TASKS.md P-A
 *   - サービス: src/services/super-admin.service.ts (deleteTenant)
 *   - UI: src/app/(dashboard)/admin/super/tenants/[id]/page.tsx
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { deleteTenant } from '@/services/super-admin.service';

export async function DELETE(
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
    const result = await deleteTenant(id, user.id);
    return NextResponse.json({ data: result });
  } catch (e) {
    if (e instanceof Error) {
      switch (e.message) {
        case 'TENANT_NOT_FOUND':
          return NextResponse.json(
            { error: { code: 'TENANT_NOT_FOUND', message: 'テナントが見つかりません' } },
            { status: 404 },
          );
        case 'MANAGEMENT_TENANT_FORBIDDEN':
          return NextResponse.json(
            {
              error: {
                code: 'MANAGEMENT_TENANT_FORBIDDEN',
                message: '管理テナント (運営内部) は削除できません',
              },
            },
            { status: 403 },
          );
        case 'ALREADY_DELETED':
          return NextResponse.json(
            { error: { code: 'ALREADY_DELETED', message: 'このテナントは既に削除済みです' } },
            { status: 409 },
          );
      }
    }
    throw e;
  }
}
