/**
 * POST /api/admin/super/billing/[id]/confirm-payment (PR-V7a / 2026-05-19)
 *
 * super_admin が銀行振込 (invoice / bank_transfer) 請求書の手動消込を実行する。
 * credit_card は Stripe Webhook で自動消込されるため本 API では拒否 (= 409)。
 *
 * 認可: super_admin role 必須。
 *
 * Body (任意):
 *   { paidAt?: string }  // ISO 8601, 省略時は now()
 *
 * 関連:
 *   - サービス: src/services/billing-management.service.ts confirmInvoicePayment
 *   - UI: src/app/(dashboard)/admin/super/billing/[yearMonth]/page.tsx
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { confirmInvoicePayment } from '@/services/billing-management.service';

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

  // body は optional。失敗しても空オブジェクト扱い
  let paidAt: Date | undefined;
  try {
    const body = await req.json().catch(() => null) as { paidAt?: string } | null;
    if (body?.paidAt) {
      const parsed = new Date(body.paidAt);
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json(
          { error: { code: 'INVALID_PAID_AT', message: 'paidAt は ISO 8601 形式で指定してください' } },
          { status: 400 },
        );
      }
      paidAt = parsed;
    }
  } catch {
    // body 未指定 → paidAt=now()
  }

  const result = await confirmInvoicePayment(id, user.id, paidAt);

  if (!result.ok) {
    if (result.error === 'NOT_FOUND') {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: '対象の請求履歴が見つかりません' } },
        { status: 404 },
      );
    }
    if (result.error === 'INVALID_PAYMENT_METHOD') {
      return NextResponse.json(
        {
          error: {
            code: 'INVALID_PAYMENT_METHOD',
            message: 'credit_card は Stripe Webhook で自動消込されます。手動操作不可',
          },
        },
        { status: 409 },
      );
    }
    if (result.error === 'INVALID_STATUS') {
      return NextResponse.json(
        {
          error: {
            code: 'INVALID_STATUS',
            message: 'status=pending のレコードのみ消込可能です',
          },
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR' } },
      { status: 500 },
    );
  }

  return NextResponse.json({
    data: {
      id: result.id,
      paidAt: result.paidAt.toISOString(),
    },
  });
}
