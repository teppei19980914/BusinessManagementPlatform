/**
 * POST /api/cron/stripe-usage-flush — Stripe Usage Record queue flush cron (PR-S6 / 2026-05-14)
 *
 * 役割:
 *   `stripe_usage_record_queue` の未送信行を Stripe Subscription Item の Usage Record として
 *   実送信する。Vercel Cron で 5 分間隔で実行。
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
 *   - vercel.json `crons` セクション (5 分間隔: `&#42;&#47;5 &#42; &#42; &#42; &#42;`)
 *   - PUBLIC_PATHS: src/config/routes.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron-auth';
import { flushStripeUsageRecordQueue } from '@/services/stripe-usage-flush.service';

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED' } },
      { status: 401 },
    );
  }

  const result = await flushStripeUsageRecordQueue();
  return NextResponse.json({ data: { source: 'cron', ...result } });
}

// 他の cron route 同様 GET は 405 で拒否 (= POST 一本化)
export async function GET() {
  return NextResponse.json(
    { error: { code: 'METHOD_NOT_ALLOWED' } },
    { status: 405 },
  );
}
