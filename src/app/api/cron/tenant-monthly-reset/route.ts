/**
 * POST /api/cron/tenant-monthly-reset - Tenant 月次リセット バッチ (PR #2-d / T-03)
 *
 * 外部 cron (cron-job.org) で毎月 1 日 00:00 UTC (= JST 09:00) に実行。
 *
 * 処理内容 (詳細は src/services/tenant-monthly-reset.service.ts 参照):
 *   1. 月初を跨いだテナントの API 呼び出しカウンタ + 課金額を 0 にリセット
 *   2. scheduledPlanChangeAt 到達テナントに scheduledNextPlan を適用 (legacy)
 *      - 2026-05-14: Expert↔Pro 即時化 + Beginner ダウングレード完全禁止により、
 *        新規にこの予約をセットするコードパスは廃止。本処理は legacy DB レコード対策。
 *
 * 認可:
 *   外部 cron (cron-job.org) 経由のみ (Authorization: Bearer <CRON_SECRET>)。不正呼び出しは 401。
 *
 * 冪等性:
 *   再実行しても結果は同じ (本サービス層が冪等保証)。外部 cron (cron-job.org) の at-least-once 配信
 *   仕様で複数回起動されても安全。
 *
 * 関連:
 *   - cron-job.org dashboard (実行スケジュール、ADR-0023 で Vercel Cron から移行)
 *   - 設計: docs/design/SUGGESTION_ENGINE.md §課金モデル
 *   - 計画: docs/roadmap/SUGGESTION_ENGINE_PLAN.md PR #2 章
 */

import { NextRequest, NextResponse } from 'next/server';
import { runTenantMonthlyReset } from '@/services/tenant-monthly-reset.service';
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

  return withCronExecutionLogging('tenant-monthly-reset', req, async () => {
    const result = await runTenantMonthlyReset();

    return {
      data: {
        source: 'cron',
        resetCount: result.resetCount,
        planAppliedCount: result.planAppliedCount,
        invalidPlanSkippedCount: result.invalidPlanSkippedCount,
        // P-5b (2026-05-08): リセット直前のスナップショット保存件数
        snapshotSavedCount: result.snapshotSavedCount,
        // chore/storage-addon-backend-removal (2026-05-26): storage_addon プラン廃止に伴い 2 列削除
        // テナント物理削除 (2026-05-08): 90 日 Grace 経過後の物理削除件数 + 削除レコード総数
        purgedTenantCount: result.purgedTenantCount,
        purgedRowCount: result.purgedRowCount,
        // 縮退モード確定仕様 (2026-05-14): 月初 embedding 補完バッチ結果
        embeddingBackfillTenantCount: result.embeddingBackfillTenantCount,
        embeddingBackfillGeneratedCount: result.embeddingBackfillGeneratedCount,
        // ADR-0020 (2026-05-25): DB 容量超過の月初請求集計結果
        dbCapacityBilledTenantCount: result.dbCapacityBilledTenantCount,
        dbCapacityBilledTotalJpy: result.dbCapacityBilledTotalJpy,
        // ADR-0021 (2026-05-26): ファイルストレージ超過の月初請求集計結果
        fileStorageBilledTenantCount: result.fileStorageBilledTenantCount,
        fileStorageBilledTotalJpy: result.fileStorageBilledTotalJpy,
      },
    };
  });
}

// 外部 cron (cron-job.org) は HTTP GET / POST どちらも対応するが、本サービスは POST に統一。
// 念のため GET でアクセスがあれば 405 で明示的に弾く。
export async function GET() {
  return NextResponse.json(
    { error: { code: 'METHOD_NOT_ALLOWED' } },
    { status: 405 },
  );
}
