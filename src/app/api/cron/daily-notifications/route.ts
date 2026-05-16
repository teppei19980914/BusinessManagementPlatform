/**
 * POST /api/cron/daily-notifications - 日次通知バッチ (PR feat/notifications-mvp)
 *
 * Vercel Cron で 1 日 1 回実行 (JST 7:00 = UTC 前日 22:00)。
 *
 * 処理内容:
 *   1. ACT (type='activity') の予定開始日/予定終了日リマインダ通知を生成
 *      - 開始: status='not_started' AND plannedStartDate=today (JST)
 *      - 終了: status≠'completed' AND plannedEndDate=today (JST)
 *   2. 既読 + readAt > 30 日 の通知を物理削除 (容量管理)
 *
 * 認可:
 *   Vercel Cron 経由のみ (Authorization: Bearer <CRON_SECRET>)。
 *   不正呼び出しは 401。
 *
 * 関連:
 *   - vercel.json `crons` セクション (実行スケジュール)
 *   - DEVELOPER_GUIDE §5.54 (本機能の KDD)
 *   - DESIGN.md §通知 (認可/削除/重複抑止の設計判断)
 */

import { NextRequest, NextResponse } from 'next/server';
import { generateDailyNotifications, cleanupReadNotifications } from '@/services/notification.service';
import { deleteExpiredPreviews } from '@/services/external-data-import.service';
import {
  updateAllStorageBytesUsed,
  checkAndStartGracePeriod,
} from '@/services/tenant-storage.service';
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

  return withCronExecutionLogging('daily-notifications', req, async () => {
    const generated = await generateDailyNotifications();
    const cleaned = await cleanupReadNotifications();
    // Phase 1 (2026-05-08): 期限切れ tenant_import_preview を物理削除 (TTL 24h)
    const expiredPreviewsDeleted = await deleteExpiredPreviews();
    // Storage add-on (Phase 2 / 2026-05-08):
    //   1. 全テナントの storageBytesUsed を pg_column_size 集計で更新 (キャッシュ刷新)
    //   2. 上限超過/解消を検知して Grace period を開始/クリア
    //   順序重要: 容量更新 → Grace 判定 (= 最新値で判定するため)
    const storageBytesUpdated = await updateAllStorageBytesUsed();
    const graceResult = await checkAndStartGracePeriod();

    return {
      data: {
        source: 'cron',
        generated,
        cleaned,
        expiredPreviewsDeleted,
        storage: {
          bytesUpdated: storageBytesUpdated,
          graceStarted: graceResult.graceStartedCount,
          graceCleared: graceResult.graceClearedCount,
        },
      },
    };
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
