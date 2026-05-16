/**
 * POST /api/cron/daily-usage-aggregation - 日次使用量集計 + 異常検知 (PR #7 / T-03)
 *
 * Vercel Cron で毎日 02:00 UTC (= JST 11:00) に実行。
 *
 * 処理内容 (詳細は src/services/usage-monitoring.service.ts 参照):
 *   1. 昨日 (UTC) の ApiCallLog をテナント別に集計
 *   2. 過去 7 日のローリング平均から spike (5x+) を異常検知
 *   3. 月次予算 (monthlyBudgetCapJpy) の 80% / 100% / 150% 到達テナントを検出
 *
 * **2026-05-14**: 旧仕様の「admin にメール通知」は廃止。集計結果は admin ダッシュボード
 *   (`/api/admin/usage-summary`) で随時参照可能。縮退モード下で別経路の出費 (メール送信単価)
 *   を増やさない方針に統一。
 *
 * 認可:
 *   Vercel Cron 経由のみ (Authorization: Bearer <CRON_SECRET>)。不正呼び出しは 401。
 *
 * 冪等性:
 *   集計は読み取りのみで副作用なし。再実行しても結果は変わらず安全 (メール送信を廃止したため、
 *   重複送信の懸念もなくなった)。
 *
 * 関連:
 *   - vercel.json `crons` セクション (実行スケジュール)
 *   - 設計: docs/design/SUGGESTION_ENGINE.md §コスト超過リスクと監視ポイント
 *   - 計画: docs/roadmap/SUGGESTION_ENGINE_PLAN.md PR #7
 */

import { NextRequest, NextResponse } from 'next/server';
import { runDailyUsageAggregation } from '@/services/usage-monitoring.service';
import { sendBeginnerExpiryNotices } from '@/services/beginner-expiry.service';
import { purgeExpiredBeginnerTenants } from '@/services/super-admin.service';
// 2026-05-13 (security/auth-secret-hardening, B-6): タイミング攻撃耐性のある共通 cron 認可ヘルパに統一。
// 2026-05-18 (PR feat/cron-execution-log): 実行履歴を super_admin から確認可能にするためロギング組込。
import { isCronAuthorized } from '@/lib/cron-auth';
import { withCronExecutionLogging } from '@/lib/cron-execution-log';

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED' } },
      { status: 401 },
    );
  }

  return withCronExecutionLogging('daily-usage-aggregation', req, async () => {
    const result = await runDailyUsageAggregation();

    // P-B (2026-05-08): Beginner プラン期限警告メールを併走実行。
    //   1 日 1 回送信される (cron のスケジュールどおり)。重複送信は service 側で防止。
    //   失敗があっても usage aggregation の結果は返す (= 部分的成功も意味のある情報)。
    const baseUrl = process.env.NEXTAUTH_URL || req.nextUrl.origin;
    const beginnerNotices = await sendBeginnerExpiryNotices(baseUrl);

    // 2026-05-11: Day 180 自動物理削除。Beginner 試用期間 (90 日) + 読み取り専用猶予 (90 日) を
    //   過ぎてもアップグレードされなかったテナントを自動的に物理削除する。Day 90 通知メールで
    //   「90 日後に自動削除」を予告済みのため、ユーザは事前に対応 (= アップグレード /
    //   セルフ削除 / エクスポート退避) する機会を得ている。
    const beginnerAutoPurge = await purgeExpiredBeginnerTenants();

    return {
      data: {
        source: 'cron',
        ...result,
        beginnerNotices,
        beginnerAutoPurge,
      },
    };
  });
}

// Vercel Cron は HTTP GET / POST どちらも対応するが、本サービスは POST に統一。
export async function GET() {
  return NextResponse.json(
    { error: { code: 'METHOD_NOT_ALLOWED' } },
    { status: 405 },
  );
}
