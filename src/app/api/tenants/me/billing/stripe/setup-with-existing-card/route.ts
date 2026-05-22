/**
 * POST /api/tenants/me/billing/stripe/setup-with-existing-card (PR #425 / 2026-05-22)
 *
 * 役割:
 *   既に Stripe Customer に登録済みのデフォルトカード (= invoice_settings.default_payment_method)
 *   を使って、Stripe Checkout を経由せず Subscription を即座に作成する UX 改善 API。
 *
 *   「銀行振込 → カード払い再切替」の度に新規 Stripe Checkout でカード番号を再入力させるのは UX が悪い。
 *   既にカードが登録されていれば、それを再利用して 1 クリックで Subscription を再作成できる。
 *
 *   フロー:
 *     1. setupSubscriptionWithExistingCard(tenantId, billingCycleAnchor) を呼出
 *     2. 既存カードあり → Subscription 作成成功 → 200 { data: { ok: true } }
 *     3. 既存カードなし → 404 { error: { code: 'NO_EXISTING_CARD' } } (呼出側で Stripe Checkout 強制遷移)
 *     4. Stripe API 失敗 → 503
 *
 *   呼出側 UI: BillingContactSection.handleSubmit (= invoice→credit_card 切替時)
 *
 * 認可: admin role 必須 (= 同テナント管理者がログイン中)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { isStripeEnabled } from '@/lib/stripe';
import { setupSubscriptionWithExistingCard } from '@/services/stripe-billing.service';
import { getTenantCurrentYearMonth } from '@/lib/tenant-time';
import { prisma } from '@/lib/db';

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  if (!isStripeEnabled()) {
    return NextResponse.json(
      { error: { code: 'STRIPE_DISABLED', message: 'クレジットカード払いは現在ご利用いただけません' } },
      { status: 403 },
    );
  }

  // billing_cycle_anchor を計算 (= JST 月初 UNIX 秒、completeStripeSetup と同じロジック)
  const tenant = await prisma.tenant.findUnique({
    where: { id: user.tenantId },
    select: { timezone: true },
  });
  const tz = tenant?.timezone ?? 'Asia/Tokyo';
  const yearMonth = getTenantCurrentYearMonth(new Date(), tz);
  const [yearStr, monthStr] = yearMonth.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextMonthStartUtc = Date.UTC(nextYear, nextMonth - 1, 1, 0, 0, 0) - 9 * 60 * 60 * 1000;
  const billingCycleAnchor = Math.floor(nextMonthStartUtc / 1000);

  const result = await setupSubscriptionWithExistingCard(user.tenantId, billingCycleAnchor);

  if (!result.ok) {
    return NextResponse.json(
      { error: { code: 'STRIPE_API_ERROR', message: result.userMessage } },
      { status: 503 },
    );
  }

  if (result.value == null) {
    // 既存カードなし → 呼出側で Stripe Checkout 強制遷移
    return NextResponse.json(
      {
        error: {
          code: 'NO_EXISTING_CARD',
          message: '既存のクレジットカードが登録されていません。新規登録画面に進んでください。',
        },
      },
      { status: 404 },
    );
  }

  return NextResponse.json({
    data: {
      ok: true,
      subscriptionId: result.value.subscriptionId,
      paymentMethodId: result.value.paymentMethodId,
    },
  });
}
