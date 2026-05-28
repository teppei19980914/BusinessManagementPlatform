/**
 * テナントストレージ使用量集計サービス。
 *
 * 役割:
 *   テナントの DB ストレージ使用量 (バイト) を計測し、ADR-0020 (DB 容量従量課金) の課金根拠と
 *   ADR-0020 §3.5 の drift 検知に利用する。
 *
 * 履歴:
 *   chore/storage-addon-backend-removal (2026-05-26):
 *     ADR-0020 (DB 容量従量課金) + ADR-0021 (添付ファイル従量課金) で完全従量課金化されたため、
 *     旧 4 段階プラン (Standard/Plus/Pro/Enterprise) 関連の以下を撤去:
 *       - 型: StorageGraceState / TenantStorageInfo / UpdateStorageAddonResult
 *       - 関数: getStorageInfo / isStorageWriteBlocked / updateStorageAddonPlan /
 *               cancelScheduledStorageAddon / checkAndStartGracePeriod /
 *               applyScheduledStorageChanges
 *       - 旧 config (@/config/storage-addon) への依存
 *
 * 提供機能:
 *   - calculateTenantStorageBytes: pg_column_size 集計 (16 テーブル静的版、互換用途)
 *   - updateStorageBytesUsedForTenant: 単一テナントの使用量を再計算 + 書き戻し
 *   - updateAllStorageBytesUsed: 全テナントの使用量再計算 + peak 同期 + Level 通知 (日次 cron)
 *   - detectDbCapacityDrift: pg_database_size と peak SUM の乖離検知 (日次 cron)
 *
 * 認可境界:
 *   呼出側で「テナント管理者 (admin) が自テナント」or「super_admin が任意テナント」を確認した前提。
 */

import { prisma } from '@/lib/db';
import { recordError } from '@/services/error-log.service';
import {
  calculateTenantStorageBytesDynamic,
  getDbInstanceSizeBytes,
} from '@/services/tenant-storage-tables.service';
// ADR-0025 (2026-05-29): DELETE 後の自動再集計で File Storage 側も同時更新するために import
import { syncTenantFileStorageUsage } from '@/services/file-storage-bucket-usage.service';
import {
  classifyDbCapacityLevel,
  DB_DRIFT_WARNING_RATIO,
  DB_DRIFT_CRITICAL_RATIO,
} from '@/config/db-capacity-pricing';

/**
 * ADR-0025 (2026-05-29): DELETE 後自動再集計の debounce 閾値 (ミリ秒)。
 * 直近 30 秒以内に再集計済なら skip し、連続削除による DB 負荷を防ぐ。
 */
export const BEGINNER_RECALC_DEBOUNCE_MS = 30 * 1000;

// ================================================================
// 公開関数: 使用量計算
// ================================================================

/**
 * テナント単位で DB の `pg_column_size` を集計し、実使用量 (バイト) を返す。
 * 主要 15 テーブルを SUM し合算する。
 *
 * パフォーマンス: 各テーブルは tenantId のインデックスがあるので O(対象行数) で完了。
 * 大量データのテナントでも数百ミリ秒程度。
 *
 * **注意**: tasks / estimates / project_members / knowledge_projects は
 *   tenantId 列を持たないため projects / knowledge 経由で join。
 *
 * 注: ADR-0020 で導入された動的計測 (36+ テーブル) は `calculateTenantStorageBytesDynamic`
 *   (= tenant-storage-tables.service) を使う。本関数は backward compat 用途で残置。
 */
export async function calculateTenantStorageBytes(tenantId: string): Promise<bigint> {
  const result = await prisma.$queryRaw<Array<{ total_bytes: bigint }>>`
    SELECT
      COALESCE((SELECT SUM(pg_column_size(t.*))::bigint FROM tenants t WHERE t.id = ${tenantId}::uuid), 0) +
      COALESCE((SELECT SUM(pg_column_size(p.*))::bigint FROM projects p WHERE p.tenant_id = ${tenantId}::uuid), 0) +
      COALESCE((SELECT SUM(pg_column_size(t.*))::bigint FROM tasks t JOIN projects p ON t.project_id = p.id WHERE p.tenant_id = ${tenantId}::uuid), 0) +
      COALESCE((SELECT SUM(pg_column_size(e.*))::bigint FROM estimates e JOIN projects p ON e.project_id = p.id WHERE p.tenant_id = ${tenantId}::uuid), 0) +
      COALESCE((SELECT SUM(pg_column_size(pm.*))::bigint FROM project_members pm JOIN projects p ON pm.project_id = p.id WHERE p.tenant_id = ${tenantId}::uuid), 0) +
      COALESCE((SELECT SUM(pg_column_size(k.*))::bigint FROM knowledges k WHERE k.tenant_id = ${tenantId}::uuid), 0) +
      COALESCE((SELECT SUM(pg_column_size(kp.*))::bigint FROM knowledge_projects kp JOIN knowledges k ON kp.knowledge_id = k.id WHERE k.tenant_id = ${tenantId}::uuid), 0) +
      COALESCE((SELECT SUM(pg_column_size(r.*))::bigint FROM risks_issues r WHERE r.tenant_id = ${tenantId}::uuid), 0) +
      COALESCE((SELECT SUM(pg_column_size(rt.*))::bigint FROM retrospectives rt WHERE rt.tenant_id = ${tenantId}::uuid), 0) +
      COALESCE((SELECT SUM(pg_column_size(m.*))::bigint FROM memos m WHERE m.tenant_id = ${tenantId}::uuid), 0) +
      COALESCE((SELECT SUM(pg_column_size(c.*))::bigint FROM customers c WHERE c.tenant_id = ${tenantId}::uuid), 0) +
      COALESCE((SELECT SUM(pg_column_size(s.*))::bigint FROM stakeholders s WHERE s.tenant_id = ${tenantId}::uuid), 0) +
      COALESCE((SELECT SUM(pg_column_size(cm.*))::bigint FROM comments cm WHERE cm.tenant_id = ${tenantId}::uuid), 0) +
      COALESCE((SELECT SUM(pg_column_size(mn.*))::bigint FROM mentions mn WHERE mn.tenant_id = ${tenantId}::uuid), 0) +
      COALESCE((SELECT SUM(pg_column_size(a.*))::bigint FROM attachments a WHERE a.tenant_id = ${tenantId}::uuid), 0) +
      COALESCE((SELECT SUM(pg_column_size(u.*))::bigint FROM users u WHERE u.tenant_id = ${tenantId}::uuid), 0)
    AS total_bytes
  `;
  return result[0]?.total_bytes ?? BigInt(0);
}

/**
 * 単一テナントの `storageBytesUsed` キャッシュを更新する (テナント管理者の設定画面遷移時 +
 * super_admin の手動再集計時に使用)。
 *
 * @returns 更新したバイト数 (テナント不在時は null)
 */
export async function updateStorageBytesUsedForTenant(
  tenantId: string,
): Promise<bigint | null> {
  const exists = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!exists) return null;

  const bytes = await calculateTenantStorageBytes(tenantId);
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      storageBytesUsed: bytes,
      storageBytesUsedAt: new Date(),
    },
  });
  return bytes;
}

/**
 * ADR-0025 (2026-05-29): DELETE 後の自動再集計 (debounce 30s 付き、fail-safe)。
 *
 * 役割:
 *   Beginner プランのテナントが DB / File Storage 無料枠を超過した状態で、
 *   ユーザが不要データを DELETE して容量を減らした際、cron 更新を待たずに
 *   キャッシュ (`storageBytesUsed` / `storageFileBytesUsed`) を即時更新する。
 *   これにより「DELETE 直後に新規作成可能」が UX として成立する。
 *
 * 動作:
 *   1. tenant.storageBytesUsedAt をチェックし、直近 BEGINNER_RECALC_DEBOUNCE_MS (30s)
 *      以内に更新されていれば skip (= 連続削除での DB 負荷防止)
 *   2. updateStorageBytesUsedForTenant() で DB 使用量を再集計
 *   3. syncTenantFileStorageUsage() で File Storage 使用量を再集計
 *   4. 例外は内部で catch + recordError、外部に throw しない (= fail-safe)
 *
 * 設計判断:
 *   - **fail-safe**: 本関数の失敗が DELETE のビジネストランザクションを巻き戻すと
 *     ユーザは「削除したのに残っている」状態に陥る。再集計は次回 cron でも回復する
 *     ため、失敗時はログ記録のみで継続。
 *   - **plan チェック不要**: 呼出側 (各 DELETE service の post-commit hook) で
 *     plan === 'beginner' を判定する。本関数は plan を見ず汎用化することで、
 *     将来 Expert/Pro でも自動再集計したくなった場合に再利用可能。
 *   - **DELETE トランザクション外で呼ぶ**: トランザクション完了 (commit) 後に
 *     呼び出すこと。トランザクション内で呼ぶと、現在の tx で DELETE 済の行が
 *     計測対象から除外されない (= isolation level 起因の race) ため、再集計値が
 *     古い値で更新されてしまう。
 *
 * 関連:
 *   - ADR: docs/adr/0025-beginner-write-guard.md §5
 *   - 仕様書: docs/specification/BEGINNER_PLAN.md §3.5
 *   - DB 再集計: updateStorageBytesUsedForTenant (本ファイル)
 *   - File Storage 再集計: syncTenantFileStorageUsage (file-storage-bucket-usage.service.ts)
 *
 * @param tenantId 対象テナント (Beginner プランの判定は呼出側責任)
 * @returns 実行結果サマリ (skipped / recalculated、failure 時も throw せず result で返却)
 */
export async function recalculateTenantStorageUsageWithDebounce(
  tenantId: string,
): Promise<{
  status: 'recalculated' | 'skipped-debounce' | 'failed';
  dbBytes?: bigint | null;
  reason?: string;
}> {
  try {
    // 1. debounce チェック
    const tenant = await prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { storageBytesUsedAt: true },
    });
    if (!tenant) {
      // テナント不在 (削除直後の race 等) は skip 扱い (= fail-safe)
      return { status: 'failed', reason: 'tenant-not-found' };
    }
    if (tenant.storageBytesUsedAt != null) {
      const elapsedMs = Date.now() - tenant.storageBytesUsedAt.getTime();
      if (elapsedMs >= 0 && elapsedMs < BEGINNER_RECALC_DEBOUNCE_MS) {
        return { status: 'skipped-debounce' };
      }
    }

    // 2-3. DB + File Storage 再集計 (並列実行で latency 短縮)
    const [dbResult, fileResult] = await Promise.allSettled([
      updateStorageBytesUsedForTenant(tenantId),
      syncTenantFileStorageUsage(tenantId),
    ]);

    if (dbResult.status === 'rejected' || fileResult.status === 'rejected') {
      // 部分失敗 → recordError、ただし throw しない (DELETE 本体は成功状態のまま継続)
      const dbErr = dbResult.status === 'rejected' ? String(dbResult.reason) : null;
      const fileErr = fileResult.status === 'rejected' ? String(fileResult.reason) : null;
      await recordError({
        severity: 'warn',
        source: 'server',
        message: `[beginner-recalc] partial failure for tenant ${tenantId}`,
        context: {
          kind: 'beginner_storage_recalc',
          tenantId,
          dbError: dbErr,
          fileError: fileErr,
          adr: 'ADR-0025',
        },
      });
      return {
        status: 'failed',
        reason: `db=${dbErr ?? 'ok'}, file=${fileErr ?? 'ok'}`,
      };
    }

    return {
      status: 'recalculated',
      dbBytes: dbResult.value,
    };
  } catch (e) {
    // 想定外例外 (= prisma 接続断等) → recordError + 'failed' で返却 (throw しない)
    try {
      await recordError({
        severity: 'warn',
        source: 'server',
        message: `[beginner-recalc] unexpected error for tenant ${tenantId}`,
        stack: e instanceof Error ? e.stack : undefined,
        context: {
          kind: 'beginner_storage_recalc',
          tenantId,
          error: e instanceof Error ? e.message : String(e),
          adr: 'ADR-0025',
        },
      });
    } catch {
      // recordError 自体が失敗してもサイレントに継続 (= fail-safe の最終境界)
    }
    return { status: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * ADR-0025 (2026-05-29): DELETE 経路で呼ぶ Beginner 専用 wrapper。
 *
 * 各 DELETE service (deleteKnowledge / deleteProject / deleteRisk / deleteRetrospective /
 * deleteMemo / deleteAttachment 等) の transaction commit 後に本関数を呼ぶ。
 *
 * 動作:
 *   1. plan を 1 query で取得
 *   2. plan === 'beginner' なら recalculateTenantStorageUsageWithDebounce() を呼出
 *   3. それ以外 (Expert/Pro/未確認) は何もしない (= cron 任せ)
 *
 * 設計判断:
 *   - **plan チェックを内包**: 呼出側で都度 fetch すると DELETE 経路ごとに記述漏れリスク。
 *     本 wrapper に集約し、各 delete service は `await maybeRecalcAfterBeginnerDelete(tenantId)`
 *     を呼ぶだけで良い設計とする (= 1 行追加で漏れなく統合)。
 *   - **fail-safe**: 呼出元の transaction には影響しない (recalculate~ 関数自体が fail-safe)。
 *   - **+1 query 許容**: Beginner プランは個人試用想定で DELETE 頻度が低く、+1 query の負荷は許容。
 *     Expert/Pro 用に呼ばれた場合も plan fetch 1 回のみで早期 return。
 *
 * 関連:
 *   - ADR: docs/adr/0025-beginner-write-guard.md §5
 *   - 仕様書: docs/specification/BEGINNER_PLAN.md §3.5
 *
 * @param tenantId 対象テナント (どの plan でも安全に呼べる)
 */
export async function maybeRecalcAfterBeginnerDelete(tenantId: string): Promise<void> {
  try {
    const tenant = await prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { plan: true },
    });
    if (tenant?.plan === 'beginner') {
      await recalculateTenantStorageUsageWithDebounce(tenantId);
    }
  } catch {
    // fail-safe: plan 取得自体が失敗しても呼出元には影響させない (= cron 任せで OK)
  }
}

/**
 * 全テナントの `storageBytesUsed` キャッシュを更新する (日次 cron + super_admin
 * ダッシュボード遷移時の on-demand 用)。
 *
 * 動作: 削除済テナントは除外し、各テナントで `calculateTenantStorageBytesDynamic` を実行 →
 *   Tenant 行に書き戻す + peak の MAX 同期 + Level 昇格時の super_admin 通知。
 *   失敗は recordError でログ取り、ループは継続。
 *
 * recordError 自体の失敗 (= error_logs テーブル不在等) は console.error
 * にフォールバックして無視する (2026-05-14: 本番で error_logs 未 migrate
 * の状況でも本処理を継続させる防御)。
 *
 * @returns 更新したテナント件数
 */
export async function updateAllStorageBytesUsed(): Promise<number> {
  // ADR-0020 (2026-05-25): 動的計測 (36+ テーブル) に切替 + peak の MAX 同期も担う。
  //   旧 calculateTenantStorageBytes (16 テーブルハードコード) は計測漏れがあるため
  //   calculateTenantStorageBytesDynamic を使用。さらに「一般 CRUD は assertStorageLimitInTx を
  //   通らない (= import 系のみ)」現状で peak が永久に 0 のまま課金漏れする問題を、
  //   本 cron で日次 MAX 同期することで吸収する (= R5 横断対応の本体)。
  //
  //   ロジック:
  //     - storageBytesUsed: 常に現在値で更新
  //     - storageBytesPeakThisMonth: MAX(current_peak, new_used) で月内 peak を月初 cron まで蓄積
  //     - dbCapacityWarningLevel: 新 peak で classify、Level 昇格時のみ super_admin 通知

  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      storageBytesPeakThisMonth: true,
      dbCapacityWarningLevel: true,
    },
  });

  let updated = 0;
  for (const t of tenants) {
    try {
      const bytes = await calculateTenantStorageBytesDynamic(t.id);
      const currentPeak = t.storageBytesPeakThisMonth;
      const newPeak = bytes > currentPeak ? bytes : currentPeak;
      const peakChanged = bytes > currentPeak;
      const newLevel = classifyDbCapacityLevel(newPeak);
      const levelChanged = newLevel !== t.dbCapacityWarningLevel;

      await prisma.tenant.update({
        where: { id: t.id },
        data: {
          storageBytesUsed: bytes,
          storageBytesUsedAt: new Date(),
          ...(peakChanged
            ? { storageBytesPeakThisMonth: bytes, storageBytesPeakAt: new Date() }
            : {}),
          ...(levelChanged ? { dbCapacityWarningLevel: newLevel } : {}),
        },
      });

      // Level 昇格時のみ super_admin に通知 (= 通知 spam 防止、storage-guard.service と同じパターン)
      if (peakChanged && levelChanged && newLevel !== 'none') {
        const order: Record<string, number> = { none: 0, l1: 1, l2: 2, l3: 3 };
        if (order[newLevel]! > order[t.dbCapacityWarningLevel]!) {
          await recordError({
            severity: newLevel === 'l3' ? 'error' : newLevel === 'l2' ? 'warn' : 'info',
            source: 'cron',
            message: `[db-capacity] Tenant ${t.id} reached Level ${newLevel.toUpperCase()} via daily cron (peak=${Number(bytes)} bytes)`,
            context: {
              kind: 'db_capacity_warning',
              tenantId: t.id,
              peakBytes: Number(bytes),
              previousLevel: t.dbCapacityWarningLevel,
              newLevel,
              source: 'daily_cron',
            },
          });
        }
      }
      updated += 1;
    } catch (e) {
      try {
        await recordError({
          severity: 'error',
          source: 'cron',
          message: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
          context: { kind: 'tenant_storage_calc', tenantId: t.id },
        });
      } catch (logErr) {
        // eslint-disable-next-line no-console -- error_logs テーブル不在等で recordError 自体が落ちた最終フォールバック
        console.error('[tenant-storage] recordError failed', logErr, 'original:', e);
      }
    }
  }
  return updated;
}

/**
 * drift 検知 batch (ADR-0020 §3.5 / 5 回目検証 R で実装)。
 *
 * 全テナント peak SUM と pg_database_size を比較し、乖離率を計算 → 閾値超で super_admin 通知。
 * 目的: 計測対象漏れ / 運営直接 SQL / vacuum bloat の早期発見。
 *
 * 動作:
 *   1. 全テナント (deletedAt=null) の storageBytesPeakThisMonth SUM
 *   2. pg_database_size(current_database())
 *   3. drift ratio = (instance - tenantSum) / tenantSum
 *   4. >= DB_DRIFT_WARNING_RATIO で warn ログ、 >= DB_DRIFT_CRITICAL_RATIO で error ログ
 *
 * 呼出元: src/app/api/cron/daily-notifications/route.ts (= 日次 cron 内ステップ)
 *
 * @returns drift 計算結果 (debug / dashboard 用)
 */
export async function detectDbCapacityDrift(): Promise<{
  tenantPeakSumBytes: bigint;
  dbInstanceSizeBytes: bigint;
  driftRatio: number;
  driftLevel: 'ok' | 'warning' | 'critical';
}> {
  // 1. テナント peak SUM (aggregate _sum でメモリ効率化)
  const peakAggregate = await prisma.tenant.aggregate({
    where: { deletedAt: null },
    _sum: { storageBytesPeakThisMonth: true },
  });
  const tenantPeakSumBytes = peakAggregate._sum.storageBytesPeakThisMonth ?? BigInt(0);

  // 2. pg_database_size
  let dbInstanceSizeBytes: bigint;
  try {
    dbInstanceSizeBytes = await getDbInstanceSizeBytes();
  } catch (e) {
    await recordError({
      severity: 'warn',
      source: 'cron',
      message: '[drift-detection] getDbInstanceSizeBytes failed',
      context: {
        kind: 'db_drift_detection',
        error: e instanceof Error ? e.message : String(e),
      },
    });
    dbInstanceSizeBytes = BigInt(0);
  }

  // 3. drift ratio
  let driftRatio = 0;
  if (tenantPeakSumBytes > BigInt(0)) {
    const diff =
      dbInstanceSizeBytes > tenantPeakSumBytes
        ? dbInstanceSizeBytes - tenantPeakSumBytes
        : BigInt(0);
    driftRatio = Number(diff) / Number(tenantPeakSumBytes);
  }

  // 4. 閾値判定 + ログ
  const driftLevel: 'ok' | 'warning' | 'critical' =
    driftRatio >= DB_DRIFT_CRITICAL_RATIO
      ? 'critical'
      : driftRatio >= DB_DRIFT_WARNING_RATIO
        ? 'warning'
        : 'ok';

  if (driftLevel !== 'ok') {
    await recordError({
      severity: driftLevel === 'critical' ? 'error' : 'warn',
      source: 'cron',
      message: `[drift-detection] db capacity drift ${(driftRatio * 100).toFixed(1)}% (${driftLevel})`,
      context: {
        kind: 'db_drift_detection',
        driftLevel,
        driftRatio,
        tenantPeakSumBytes: tenantPeakSumBytes.toString(),
        dbInstanceSizeBytes: dbInstanceSizeBytes.toString(),
      },
    });
  }

  return { tenantPeakSumBytes, dbInstanceSizeBytes, driftRatio, driftLevel };
}
