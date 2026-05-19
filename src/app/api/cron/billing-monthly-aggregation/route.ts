/**
 * POST /api/cron/billing-monthly-aggregation (PR-V7a / 2026-05-19)
 *
 * 役割:
 *   invoice / bank_transfer 払いテナントの月次請求を集計し、BillingHistory に upsert する。
 *   credit_card 払いは Stripe Webhook で自動同期されるため対象外。
 *
 * 推奨スケジュール:
 *   - 毎月 2 日 00:00 UTC (= JST 09:00、当月 1 日までの全 ApiCallLog 記録完了を待つ)
 *   - 引数なしで前月 (= getTenantPreviousYearMonth 'Asia/Tokyo' 基準) を集計
 *
 * クエリパラメータ (任意):
 *   ?yearMonth=YYYY-MM  指定月を集計 (= retroactive run / 手動再実行)
 *
 * 認可:
 *   Authorization: Bearer <CRON_SECRET>
 *
 * 失敗ハンドリング:
 *   - per-tenant try/catch でテナント単位の失敗は cron 全体を止めない
 *   - 失敗テナントは result.errors[] に蓄積 + 戻り値で確認可能
 *   - cron-execution-log に payload として記録 (= super_admin /cron-history で確認可能)
 *
 * 関連:
 *   - サービス: src/services/billing-aggregation.service.ts
 *   - 監査 G1 (S 優先度): invoice 月次集計の自動化
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@/lib/cron-auth';
import { withCronExecutionLogging } from '@/lib/cron-execution-log';
import { aggregateInvoiceBillingForMonth } from '@/services/billing-aggregation.service';
import { getTenantPreviousYearMonth } from '@/lib/tenant-time';

const VALID_YEAR_MONTH = /^\d{4}-\d{2}$/;

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED' } },
      { status: 401 },
    );
  }

  // クエリパラメータで yearMonth 指定可能。未指定なら JST 基準の前月を集計
  const url = new URL(req.url);
  const yearMonthParam = url.searchParams.get('yearMonth');
  const yearMonth
    = yearMonthParam && VALID_YEAR_MONTH.test(yearMonthParam)
      ? yearMonthParam
      : getTenantPreviousYearMonth(new Date(), 'Asia/Tokyo');

  return withCronExecutionLogging('billing-monthly-aggregation', req, async () => {
    const result = await aggregateInvoiceBillingForMonth(yearMonth);
    return { data: { source: 'cron', ...result } };
  });
}

export async function GET() {
  return NextResponse.json(
    { error: { code: 'METHOD_NOT_ALLOWED' } },
    { status: 405 },
  );
}
