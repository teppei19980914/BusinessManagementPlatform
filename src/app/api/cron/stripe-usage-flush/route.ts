/**
 * POST /api/cron/stripe-usage-flush — Stripe Usage Record queue flush cron (PR-S6 / 2026-05-14)
 *
 * 役割:
 *   `stripe_usage_record_queue` の未送信行を Stripe Subscription Item の Usage Record として
 *   実送信する。Vercel Cron で日次 (05:00 UTC = JST 14:00) で実行。
 *
 *   Vercel Hobby プラン制約により最小間隔が「1 日 1 回」のため日次運用に統一 (2026-05-14)。
 *   Stripe Usage Record は timestamp パラメタで実際の呼出時刻を送るため、翌日送信でも
 *   月末請求の正確性は保たれる (= 35 日以内の過去 timestamp を Stripe が受領)。
 *
 * 認可:
 *   `Authorization: Bearer <CRON_SECRET>` のみ通過 (= 共通 cron-auth ヘルパで定数時間検証)。
 *   middleware の Cookie セッション検査は PUBLIC_PATHS により素通り。
 *
 * 冪等性:
 *   - 送信成功時は `sentAt = now` でマーク → 次回 cron で同じ行は拾わない
 *   - 送信失敗時は `retryCount++` + `nextSendAt` を exponential backoff で更新
 *   - 5 回失敗で `nextSendAt = null` (= DLQ 入り、再送停止)
 *   - 同一 `apiCallLogId` の重複送信は Stripe 側 idempotency_key で防止
 *
 * 関連:
 *   - サービス: src/services/stripe-usage-flush.service.ts
 *   - vercel.json `crons` セクション (日次: `0 5 * * *` = 05:00 UTC)
 *   - PUBLIC_PATHS: src/config/routes.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron-auth';
// 2026-05-18 (PR feat/cron-execution-log): 実行履歴を super_admin から確認可能にするためロギング組込。
import { withCronExecutionLogging } from '@/lib/cron-execution-log';
import { flushStripeUsageRecordQueue } from '@/services/stripe-usage-flush.service';

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED' } },
      { status: 401 },
    );
  }

  return withCronExecutionLogging('stripe-usage-flush', req, async () => {
    const result = await flushStripeUsageRecordQueue();
    return { data: { source: 'cron', ...result } };
  });
}

// 他の cron route 同様 GET は 405 で拒否 (= POST 一本化)
export async function GET() {
  return NextResponse.json(
    { error: { code: 'METHOD_NOT_ALLOWED' } },
    { status: 405 },
  );
}
