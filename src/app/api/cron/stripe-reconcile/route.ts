/**
 * POST /api/cron/stripe-reconcile — Stripe ↔ DB 状態照合 cron (PR-V7 #5 / 2026-05-19)
 *
 * 役割:
 *   credit_card 払いテナント全件について Stripe Subscription 状態を取得し、DB 側
 *   `tenant.stripeSubscriptionStatus` と乖離があれば Stripe 値で上書き + auditLog 記録。
 *   月初 Vercel Cron で実行 (日次でも問題ないが、Stripe API 呼出コスト最適化のため月次)。
 *
 * 認可:
 *   `Authorization: Bearer <CRON_SECRET>` のみ通過 (= cron-auth 共通ヘルパで定数時間検証)。
 *
 * 失敗ハンドリング:
 *   per-tenant try/catch なので 1 件失敗で cron 全体は止まらない。失敗テナントは
 *   `errors` 配列で報告 + recordError でログ → super_admin が cron-history 画面で確認可能。
 *
 * 関連:
 *   - サービス: src/services/stripe-reconcile.service.ts
 *   - vercel.json `crons` セクション (月次: `0 6 1 * *` = 毎月 1 日 06:00 UTC = JST 15:00)
 *   - PUBLIC_PATHS: src/config/routes.ts (middleware bypass)
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron-auth';
import { withCronExecutionLogging } from '@/lib/cron-execution-log';
import {
  reconcileStripeSubscriptions,
  reconcileBillingHistoryAmounts,
} from '@/services/stripe-reconcile.service';

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED' } },
      { status: 401 },
    );
  }

  return withCronExecutionLogging('stripe-reconcile', req, async () => {
    // 1. Subscription 状態の照合 (= 既存 PR-V7 #5)
    const subscriptions = await reconcileStripeSubscriptions();
    // 2. PR-V7a B-2 (2026-05-19): BillingHistory 金額の照合 (直近 3 ヶ月)
    const amounts = await reconcileBillingHistoryAmounts(3);
    return { data: { source: 'cron', subscriptions, amounts } };
  });
}

export async function GET() {
  return NextResponse.json(
    { error: { code: 'METHOD_NOT_ALLOWED' } },
    { status: 405 },
  );
}
