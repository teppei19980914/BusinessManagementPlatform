/**
 * POST /api/tenants/me/billing/stripe/verify (PR-S3 / 2026-05-14)
 *
 * 役割:
 *   テナント管理者がプラン変更前に「現在のカードが利用可能か」を検証する。
 *   $0 SetupIntent を使った authorization-only verification を実行。
 *
 *   通常はプラン変更ダイアログから自動で呼ばれる (= PR-S5 で UI 実装)。
 *   manual 検証ボタン経由でも呼べる。
 *
 * 認可: admin role 必須
 *
 * Request body: なし
 *
 * Response:
 *   200 `{ data: { status: 'valid' | 'expired' | 'declined', failureReason?, cardExpiresAt? } }`
 *   400 / 401 / 403 / 409 / 503
 *
 * 関連:
 *   仕様: docs/business/STRIPE_BILLING.md §4.4
 *   UI: docs/specification/STRIPE_PAYMENT_UI.md §3 (プラン変更時のカード検証)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { isStripeEnabled } from '@/lib/stripe';
import { verifyTenantCard } from '@/services/stripe-billing.service';

export async function POST(_req: NextRequest) {
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

  const result = await verifyTenantCard(user.tenantId);

  if (!result.ok) {
    if (result.code === 'invalid_request') {
      return NextResponse.json(
        {
          error: {
            code: result.detail === 'card_not_registered' ? 'NO_CARD_REGISTERED' : 'INVALID_REQUEST',
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

  return NextResponse.json({ data: result.value });
}
