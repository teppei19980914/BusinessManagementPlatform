/**
 * POST /api/tenants/me/billing/stripe/portal (PR-S3 / 2026-05-14)
 *
 * 役割:
 *   テナント管理者が「🔧 Stripe ポータルで管理」ボタンを押下時、Stripe Customer Portal Session を
 *   作成して `session.url` を返す。フロントはそこへリダイレクトしてカード更新 / 履歴閲覧。
 *
 * 認可: admin role 必須
 *
 * Request body: `{ returnUrl: string }`
 *
 * Response:
 *   200 `{ data: { portalUrl: string } }`
 *   400 / 401 / 403 / 409 NO_STRIPE_CUSTOMER / 503
 *
 * 関連:
 *   仕様: docs/business/STRIPE_BILLING.md §4.5
 *   UI: docs/specification/STRIPE_PAYMENT_UI.md §2.3
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { isStripeEnabled } from '@/lib/stripe';
import { createCustomerPortalSession } from '@/services/stripe-billing.service';

const PortalBodySchema = z.object({
  returnUrl: z.string().url(),
});

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  if (!isStripeEnabled()) {
    return NextResponse.json(
      {
        error: {
          code: 'STRIPE_DISABLED',
          message: 'クレジットカード払い機能は現在ご利用いただけません',
        },
      },
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
  const parsed = PortalBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? '入力内容に誤りがあります',
        },
      },
      { status: 400 },
    );
  }

  const result = await createCustomerPortalSession(user.tenantId, parsed.data.returnUrl);

  if (!result.ok) {
    // Stripe Customer 未登録は専用エラー、それ以外は 503
    if (result.code === 'invalid_request' && result.detail === 'stripe_customer_id_missing') {
      return NextResponse.json(
        {
          error: {
            code: 'NO_STRIPE_CUSTOMER',
            message: result.userMessage,
          },
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      {
        error: {
          code: 'STRIPE_API_ERROR',
          message: result.userMessage,
        },
      },
      { status: 503 },
    );
  }

  return NextResponse.json({ data: { portalUrl: result.value.url } });
}
