/**
 * POST /api/cron/stripe-auto-suspend — Stripe 引落失敗による自動 suspend cron (PR-S6 / 2026-05-14)
 *
 * 役割:
 *   `tenant.autoSuspendScheduledAt <= now` のテナントに対し、`suspendTenant('payment_delinquent')`
 *   を呼出して read-only モードへ強制移行する。外部 cron (cron-job.org) で日次実行。
 *
 *   autoSuspendScheduledAt は Webhook (PR-S4) が `customer.subscription.updated` の status='past_due'
 *   を受信した時に `now + 3 日` でセットされている。
 *
 * 認可:
 *   `Authorization: Bearer <CRON_SECRET>` のみ通過 (= 共通 cron-auth ヘルパで定数時間検証)。
 *   middleware の Cookie セッション検査は PUBLIC_PATHS により素通り。
 *
 * 冪等性:
 *   - 既に suspendedAt != null のテナントは ALREADY_SUSPENDED で skip
 *   - 成功時に autoSuspendScheduledAt = null をクリア (= 次回 cron で再処理されない)
 *
 * 関連:
 *   - サービス: src/services/stripe-auto-suspend.service.ts
 *   - 既存 suspend: src/services/super-admin.service.ts suspendTenant() (= PR #372)
 *   - 自動再開: src/services/stripe-webhook-handlers.service.ts (PR-S4 で invoice.paid / sub.active)
 *   - cron-job.org dashboard (日次: `0 4 * * *` = JST 13:00、ADR-0023 で Vercel Cron から移行)
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron-auth';
// 2026-05-18 (PR feat/cron-execution-log): 実行履歴を super_admin から確認可能にするためロギング組込。
import { withCronExecutionLogging } from '@/lib/cron-execution-log';
import { autoSuspendDelinquentTenants } from '@/services/stripe-auto-suspend.service';

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED' } },
      { status: 401 },
    );
  }

  return withCronExecutionLogging('stripe-auto-suspend', req, async () => {
    const result = await autoSuspendDelinquentTenants();
    return { data: { source: 'cron', ...result } };
  });
}

export async function GET() {
  return NextResponse.json(
    { error: { code: 'METHOD_NOT_ALLOWED' } },
    { status: 405 },
  );
}
