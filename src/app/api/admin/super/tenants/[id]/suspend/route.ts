/**
 * POST /api/admin/super/tenants/[id]/suspend (PR #372 / 2026-05-14)
 *
 * 役割:
 *   super_admin が支払い滞納 / TOS 違反等で対象テナントを read-only モードに強制移行する。
 *   write 系 HTTP method (POST/PATCH/PUT/DELETE) は middleware で 403 遮断、GET 系の閲覧と
 *   self-delete / プラン変更は引き続き可能。配下の全 user の tokenVersion を increment し
 *   既存セッションを即時失効させる。
 *
 * Request body:
 *   { reason: 'payment_delinquent' | 'tos_violation' | 'other' }
 *
 * Response:
 *   200 { data: { tenantId, suspendedAt, suspendReason, invalidatedSessionCount } }
 *
 * 認可:
 *   - super_admin role 必須 (それ以外は 403)
 *   - 管理テナント (MANAGEMENT_TENANT_ID) は停止禁止 (= 自爆防止)
 *
 * エラー:
 *   - 400 VALIDATION_ERROR / INVALID_REASON
 *   - 401: 未認証
 *   - 403: super_admin 以外 / 管理テナント停止試行
 *   - 404: テナント不在
 *   - 409: 削除済 / 既に停止中
 *
 * 関連:
 *   - サービス: src/services/super-admin.service.ts (suspendTenant)
 *   - 解除 API: POST .../resume
 *   - 仕様: docs/business/PAYMENT_TERMS.md §2.3
 *   - 運用: docs/operations/PAYMENT_DELINQUENCY_SOP.md §3
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { suspendTenant, SUSPEND_REASONS } from '@/services/super-admin.service';

const SuspendBodySchema = z.object({
  reason: z.enum(SUSPEND_REASONS),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  if (!isSuperAdmin(user)) {
    return NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'リクエストボディが不正です (JSON)' } },
      { status: 400 },
    );
  }

  const parsed = SuspendBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message:
            parsed.error.issues[0]?.message ?? '理由 (reason) は payment_delinquent / tos_violation / other のいずれか',
        },
      },
      { status: 400 },
    );
  }

  try {
    const result = await suspendTenant(id, parsed.data.reason, user.id);
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
                message: '管理テナント (運営内部) は停止できません',
              },
            },
            { status: 403 },
          );
        case 'TENANT_DELETED':
          return NextResponse.json(
            {
              error: {
                code: 'TENANT_DELETED',
                message: 'このテナントは既に削除済みのため停止できません',
              },
            },
            { status: 409 },
          );
        case 'ALREADY_SUSPENDED':
          return NextResponse.json(
            {
              error: {
                code: 'ALREADY_SUSPENDED',
                message: 'このテナントは既に停止中です',
              },
            },
            { status: 409 },
          );
        case 'INVALID_REASON':
          return NextResponse.json(
            { error: { code: 'INVALID_REASON', message: '理由コードが不正です' } },
            { status: 400 },
          );
      }
    }
    throw e;
  }
}
