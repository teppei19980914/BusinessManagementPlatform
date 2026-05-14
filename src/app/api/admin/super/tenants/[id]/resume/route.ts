/**
 * POST /api/admin/super/tenants/[id]/resume (PR #372 / 2026-05-14)
 *
 * 役割:
 *   read-only 強制移行中のテナントを通常運用へ復帰させる。入金確認 / 違反解消等の後、
 *   super_admin が手動で実行する。配下の全 user の tokenVersion を increment し、
 *   再ログイン後の新 JWT claim (tenantSuspendedAt=null) で middleware の遮断が解除される。
 *
 * Request body: 不要 (空オブジェクト or なし)
 *
 * Response:
 *   200 { data: { tenantId, resumedAt, invalidatedSessionCount } }
 *
 * 認可:
 *   - super_admin role 必須
 *
 * エラー:
 *   - 401: 未認証
 *   - 403: super_admin 以外
 *   - 404: テナント不在
 *   - 409: 削除済 / 停止中でないテナントへの resume (誤操作検知)
 *
 * 関連:
 *   - サービス: src/services/super-admin.service.ts (resumeTenant)
 *   - 停止 API: POST .../suspend
 *   - 仕様: docs/business/PAYMENT_TERMS.md §2.3
 *   - 運用: docs/operations/PAYMENT_DELINQUENCY_SOP.md §3.5
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { resumeTenant } from '@/services/super-admin.service';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  if (!isSuperAdmin(user)) {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const { id } = await params;

  try {
    const result = await resumeTenant(id, user.id);
    return NextResponse.json({ data: result });
  } catch (e) {
    if (e instanceof Error) {
      switch (e.message) {
        case 'TENANT_NOT_FOUND':
          return NextResponse.json(
            { error: { code: 'TENANT_NOT_FOUND', message: 'テナントが見つかりません' } },
            { status: 404 },
          );
        case 'TENANT_DELETED':
          return NextResponse.json(
            {
              error: {
                code: 'TENANT_DELETED',
                message: 'このテナントは既に削除済みのため再開できません',
              },
            },
            { status: 409 },
          );
        case 'NOT_SUSPENDED':
          return NextResponse.json(
            {
              error: {
                code: 'NOT_SUSPENDED',
                message: 'このテナントは停止中ではありません',
              },
            },
            { status: 409 },
          );
      }
    }
    throw e;
  }
}
