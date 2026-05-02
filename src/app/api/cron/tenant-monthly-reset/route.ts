/**
 * POST /api/cron/tenant-monthly-reset - Tenant 月次リセット バッチ (PR #2-d / T-03)
 *
 * Vercel Cron で毎月 1 日 00:00 UTC (= JST 09:00) に実行。
 *
 * 処理内容 (詳細は src/services/tenant-monthly-reset.service.ts 参照):
 *   1. 月初を跨いだテナントの API 呼び出しカウンタ + 課金額を 0 にリセット
 *   2. scheduledPlanChangeAt 到達テナントに scheduledNextPlan を適用
 *      (Beginner ダウングレード等の翌月適用)
 *
 * 認可:
 *   Vercel Cron 経由のみ (Authorization: Bearer <CRON_SECRET>)。不正呼び出しは 401。
 *
 * 冪等性:
 *   再実行しても結果は同じ (本サービス層が冪等保証)。Vercel Cron の at-least-once 配信
 *   仕様で複数回起動されても安全。
 *
 * 関連:
 *   - vercel.json `crons` セクション (実行スケジュール)
 *   - 設計: docs/design/SUGGESTION_ENGINE.md §課金モデル
 *   - 計画: docs/roadmap/SUGGESTION_ENGINE_PLAN.md PR #2 章
 */

import { NextRequest, NextResponse } from 'next/server';
import { runTenantMonthlyReset } from '@/services/tenant-monthly-reset.service';

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

  const result = await runTenantMonthlyReset();

  return NextResponse.json({
    data: {
      source: 'cron',
      resetCount: result.resetCount,
      planAppliedCount: result.planAppliedCount,
      invalidPlanSkippedCount: result.invalidPlanSkippedCount,
    },
  });
}

// Vercel Cron は HTTP GET / POST どちらも対応するが、本サービスは POST に統一。
// 念のため GET でアクセスがあれば 405 で明示的に弾く。
export async function GET() {
  return NextResponse.json(
    { error: { code: 'METHOD_NOT_ALLOWED' } },
    { status: 405 },
  );
}
