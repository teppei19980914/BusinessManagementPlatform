/**
 * POST /api/cron/daily-usage-aggregation - 日次使用量集計 + 異常検知 (PR #7 / T-03)
 *
 * Vercel Cron で毎日 02:00 UTC (= JST 11:00) に実行。
 *
 * 処理内容 (詳細は src/services/usage-monitoring.service.ts 参照):
 *   1. 昨日 (UTC) の ApiCallLog をテナント別に集計
 *   2. 過去 7 日のローリング平均から spike (5x+) を異常検知
 *   3. 月次予算 (monthlyBudgetCapJpy) の 80% / 100% / 150% 到達テナントを検出
 *   4. 検出があれば admin (systemRole='admin') にメール通知
 *
 * 認可:
 *   Vercel Cron 経由のみ (Authorization: Bearer <CRON_SECRET>)。不正呼び出しは 401。
 *
 * 冪等性:
 *   集計は読み取りのみで副作用なし。再実行でメール通知が複数回送られる可能性はあるが、
 *   Vercel Cron は at-least-once でも 1 日 1 回起動が大半のため許容範囲。
 *
 * 関連:
 *   - vercel.json `crons` セクション (実行スケジュール)
 *   - 設計: docs/design/SUGGESTION_ENGINE.md §コスト超過リスクと監視ポイント
 *   - 計画: docs/roadmap/SUGGESTION_ENGINE_PLAN.md PR #7
 */

import { NextRequest, NextResponse } from 'next/server';
import { runDailyUsageAggregation } from '@/services/usage-monitoring.service';

function isCronAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  const header = req.headers.get('authorization');
  return header === `Bearer ${cronSecret}`;
}

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED' } },
      { status: 401 },
    );
  }

  const result = await runDailyUsageAggregation();

  return NextResponse.json({
    data: {
      source: 'cron',
      ...result,
    },
  });
}

// Vercel Cron は HTTP GET / POST どちらも対応するが、本サービスは POST に統一。
export async function GET() {
  return NextResponse.json(
    { error: { code: 'METHOD_NOT_ALLOWED' } },
    { status: 405 },
  );
}
