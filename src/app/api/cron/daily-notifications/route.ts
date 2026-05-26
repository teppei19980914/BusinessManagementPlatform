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
// ADR-0020 (2026-05-25): checkAndStartGracePeriod は 4 段階プラン廃止に伴い無効化。
//   write 拒否は assertStorageLimitInTx (storage-guard.service) の 50GB ハードキャップに一本化。
// 5 回目検証 R で追加: drift detection batch を日次実行 (ADR-0020 §3.5 / §8.3)
import {
  updateAllStorageBytesUsed,
  detectDbCapacityDrift,
} from '@/services/tenant-storage.service';
// ADR-0021 (2026-05-26): ファイルストレージの bucket 集計 + drift 検知 + anomaly
import {
  updateAllTenantFileStorageUsage,
  detectFileStorageDrift,
} from '@/services/file-storage-bucket-usage.service';
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
    // ADR-0020 (2026-05-25): Grace period 判定は廃止。50GB ハードキャップは即時 storage-guard で判定。
    //   日次 cron では storageBytesUsed のキャッシュ更新 + peak MAX 同期 + drift 検知を実行。
    const storageBytesUpdated = await updateAllStorageBytesUsed();
    // 5 回目検証 R: 全テナント peak SUM vs pg_database_size 乖離率を計測し閾値超で super_admin 通知
    const driftResult = await detectDbCapacityDrift().catch((e) => {
      // drift 検知失敗は他のステップを止めない (= 既存挙動と整合)
      return {
        tenantPeakSumBytes: BigInt(0),
        dbInstanceSizeBytes: BigInt(0),
        driftRatio: 0,
        driftLevel: 'ok' as const,
        error: e instanceof Error ? e.message : String(e),
      };
    });

    // ADR-0021 (2026-05-26): ファイルストレージの日次集計 + drift + anomaly
    //   各テナントの bucket / Attachment SUM を再計算し peak / level / yesterday を更新。
    //   anomaly (+5GB/day) は内部で super_admin recordError。
    const fileStorageUpdate = await updateAllTenantFileStorageUsage().catch((e) => ({
      updatedCount: 0,
      anomalyCount: 0,
      levelChangedCount: 0,
      error: e instanceof Error ? e.message : String(e),
    }));
    const fileStorageDrift = await detectFileStorageDrift().catch((e) => ({
      attachmentSumBytes: BigInt(0),
      bucketSumBytes: BigInt(0),
      driftRatio: 0,
      driftLevel: 'ok' as const,
      error: e instanceof Error ? e.message : String(e),
    }));

    return {
      data: {
        source: 'cron',
        generated,
        cleaned,
        expiredPreviewsDeleted,
        storage: {
          bytesUpdated: storageBytesUpdated,
          driftRatio: driftResult.driftRatio,
          driftLevel: driftResult.driftLevel,
        },
        fileStorage: {
          tenantsUpdated: fileStorageUpdate.updatedCount,
          anomalyCount: fileStorageUpdate.anomalyCount,
          levelChangedCount: fileStorageUpdate.levelChangedCount,
          driftRatio: fileStorageDrift.driftRatio,
          driftLevel: fileStorageDrift.driftLevel,
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
