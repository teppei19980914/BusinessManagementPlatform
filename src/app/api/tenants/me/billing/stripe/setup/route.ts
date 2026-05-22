/**
 * POST /api/tenants/me/billing/stripe/setup (PR-S3 / 2026-05-14)
 *
 * 役割:
 *   テナント管理者が「💳 クレジットカード払いに切替」ボタン押下時、Stripe Checkout Session を
 *   作成して `session.url` を返す。フロントエンドはそこへリダイレクトしてカード入力させる。
 *
 *   完了後の戻り先は `success_url` (= `/api/tenants/me/billing/stripe/setup/complete`)、
 *   そこで Subscription 作成 + paymentMethod 切替を実行する。失敗時は `cancel_url` に戻る。
 *
 * 認可: admin role 必須
 *
 * Request body: `{ returnUrl: string }`
 *   - 切替成功 / 失敗時に最終的に戻る画面の URL (= `/settings/tenant`)
 *
 * Response:
 *   200 `{ data: { checkoutUrl: string } }` - フロントが window.location = checkoutUrl
 *   400 VALIDATION_ERROR - body 不正
 *   401 - 未認証
 *   403 - admin 以外
 *   403 STRIPE_DISABLED - feature flag (STRIPE_ENABLED) 無効
 *   409 ALREADY_CREDIT_CARD - 既に credit_card 払い
 *   503 - Stripe API ダウン / 設定不備
 *
 * 関連:
 *   仕様: docs/business/STRIPE_BILLING.md §4.1 (切替フロー)
 *   詳細設計: docs/design/STRIPE_TECHNICAL_DESIGN.md §A-1 (Phase 1-2)
 *   UI: docs/specification/STRIPE_PAYMENT_UI.md §2.3
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { isStripeEnabled } from '@/lib/stripe';
import { createCheckoutSessionForCardSetup } from '@/services/stripe-billing.service';

const SetupBodySchema = z.object({
  /** 切替成功/失敗時の最終戻り先 URL (= UI の /settings/tenant) */
  returnUrl: z.string().url(),
});

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  // feature flag チェック
  if (!isStripeEnabled()) {
    return NextResponse.json(
      {
        error: {
          code: 'STRIPE_DISABLED',
          message: 'クレジットカード払いは現在ご利用いただけません',
        },
      },
      { status: 403 },
    );
  }

  // body 検証
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'リクエスト JSON が不正です' } },
      { status: 400 },
    );
  }
  const parsed = SetupBodySchema.safeParse(body);
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

  // PR #425 (2026-05-22) 再改修: ガードを撤去 (= カード変更モード対応)。
  //
  // 旧ガード (= stripeSubscriptionId 既存で 409 ALREADY_HAS_SUBSCRIPTION) は、Customer Portal で
  // カード管理する前提だったが、Stripe 仕様で「Customer Portal のデフォルト変更は既存
  // Subscription の引落カードに反映されない」事故が発生した (= ユーザが Portal で変えたつもりが
  // 古いカードに引落)。
  //
  // 新動線: 「クレジットカード情報更新」ボタン → 本 endpoint → Stripe Checkout (新カード入力) →
  // completeStripeSetup の「カード変更モード」分岐で Subscription.default_payment_method を直接 update。
  // この経路を許容するため、stripeSubscriptionId 既存でも setup は許可する。
  //
  // completeStripeSetup 側で:
  //   - Subscription 未作成 (= TC-1 初回 / TC-7 後の再設定) → 新規 Subscription 作成
  //   - Subscription 既存 (= カード変更モード) → default_payment_method update のみ (Subscription 維持)
  // に分岐するため、UI バイパス / 二重 Subscription 作成のリスクは completeStripeSetup 側で吸収する。

  // Stripe Checkout Session 作成 (= Customer も同時に自動作成)
  // 詳細設計 §A-1 Phase 1-2: Customer は事前作成して DB に保存、Checkout は setup mode で session のみ
  const result = await createCheckoutSessionForCardSetup(user.tenantId, parsed.data.returnUrl);

  if (!result.ok) {
    // Stripe API 失敗時
    return NextResponse.json(
      {
        error: {
          code: result.code === 'invalid_request' ? 'INVALID_REQUEST' : 'STRIPE_API_ERROR',
          message: result.userMessage,
        },
      },
      { status: 503 },
    );
  }

  // Stripe Checkout の URL は session.url に含まれる (= mode='setup' の場合は必ず存在)
  if (result.value.url == null) {
    return NextResponse.json(
      {
        error: {
          code: 'STRIPE_API_ERROR',
          message: 'Stripe Checkout の URL を取得できませんでした',
        },
      },
      { status: 503 },
    );
  }

  return NextResponse.json({ data: { checkoutUrl: result.value.url } });
}
