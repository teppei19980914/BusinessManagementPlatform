/**
 * POST /api/cron/tenant-monthly-reset - Tenant 月次リセット バッチ (PR #2-d / T-03)
 *
 * Vercel Cron で毎月 1 日 00:00 UTC (= JST 09:00) に実行。
 *
 * 処理内容 (詳細は src/services/tenant-monthly-reset.service.ts 参照):
 *   1. 月初を跨いだテナントの API 呼び出しカウンタ + 課金額を 0 にリセット
 *   2. scheduledPlanChangeAt 到達テナントに scheduledNextPlan を適用 (legacy)
 *      - 2026-05-14: Expert↔Pro 即時化 + Beginner ダウングレード完全禁止により、
 *        新規にこの予約をセットするコードパスは廃止。本処理は legacy DB レコード対策。
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
// 2026-05-13 (security/auth-secret-hardening, B-6): タイミング攻撃耐性のある共通 cron 認可ヘルパに統一。
import { isCronAuthorized } from '@/lib/cron-auth';

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
      // P-5b (2026-05-08): リセット直前のスナップショット保存件数
      snapshotSavedCount: result.snapshotSavedCount,
      // Storage add-on (Phase 2 / 2026-05-08): ダウングレード予約適用件数 / 使用量超過 skip 件数
      storageAddonAppliedCount: result.storageAddonAppliedCount,
      storageAddonSkippedCount: result.storageAddonSkippedCount,
      // テナント物理削除 (2026-05-08): 90 日 Grace 経過後の物理削除件数 + 削除レコード総数
      purgedTenantCount: result.purgedTenantCount,
      purgedRowCount: result.purgedRowCount,
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
