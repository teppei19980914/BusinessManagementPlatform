/**
 * ファイルストレージ集計サービス (ADR-0021 / 2026-05-26)
 *
 * 役割:
 *   1. テナント別の Supabase Storage 使用量を集計し Tenant.storageFileBytesUsed をキャッシュ更新
 *   2. 月中 peak (= 課金根拠の真値) を MAX 同期
 *   3. drift 検知: アプリ層 Attachment.sizeBytes SUM vs Supabase storage.objects 実容量
 *   4. anomaly 検知: 24h で +5GB 以上増加で super_admin alert
 *   5. fileStorageWarningLevel を classify で更新 (= 通知 spam 防止)
 *
 * 真値の二重定義 (= drift 検知):
 *   - Truth 1 (= 課金根拠): Attachment.sizeBytes SUM (= アプリ層が把握しているサイズ)
 *   - Truth 2 (= バケット実態): storage.objects.metadata->>'size' SUM
 *   - 乖離率 50%/100% で warning/critical alert (= feedback_drift_detection_design)
 *
 * 設計判断:
 *   - storage.objects 直接 SQL アクセスを採用 (Supabase REST API より高速・コスト無料)
 *   - 同 PostgreSQL connection なので Prisma $queryRaw で参照可能 (service_role 権限を前提)
 *   - storage.objects が存在しない環境 (ローカル dev w/o Supabase) では Attachment SUM をフォールバック
 *
 * 関連:
 *   - ADR: docs/adr/0021-file-storage-usage-based-billing.md
 *   - storage-guard: src/services/storage-guard.service.ts (assertFileStorageLimitInTx)
 *   - daily cron: src/app/api/cron/daily-notifications/route.ts (本サービスを呼出)
 *   - 月初 cron: src/services/tenant-monthly-reset.service.ts (processTenantFileStorageOverage)
 *   - Memory: feedback_drift_detection_design.md / feedback_billing_invariant.md
 */

import { prisma } from '@/lib/db';
import { recordError } from '@/services/error-log.service';
import {
  FILE_STORAGE_ANOMALY_DAILY_INCREASE_BYTES,
  FILE_STORAGE_DRIFT_CRITICAL_RATIO,
  FILE_STORAGE_DRIFT_WARNING_RATIO,
  classifyFileStorageLevel,
  type FileStorageWarningLevel,
} from '@/config/file-storage-pricing';

/** Supabase Storage bucket 名 (env 未設定時は default 'attachments') */
const STORAGE_BUCKET = process.env['SUPABASE_STORAGE_BUCKET'] ?? 'attachments';

// ============================================================
// 集計クエリ
// ============================================================

/**
 * テナント別 Supabase Storage 実容量を `storage.objects` から集計。
 *
 * SQL: `SELECT SUM((metadata->>'size')::bigint) FROM storage.objects WHERE bucket_id = 'attachments' AND name LIKE 'tenants/{tid}/%'`
 *
 * 失敗時 (storage schema 不在 / 権限不足) は `null` を返す。
 * 呼出側で Attachment SUM フォールバックを使用する。
 */
export async function calculateTenantBucketBytes(tenantId: string): Promise<bigint | null> {
  try {
    const result = await prisma.$queryRaw<Array<{ total_bytes: bigint | null }>>`
      SELECT COALESCE(SUM(((metadata->>'size')::bigint)), 0)::bigint AS total_bytes
        FROM storage.objects
       WHERE bucket_id = ${STORAGE_BUCKET}
         AND name LIKE ${'tenants/' + tenantId + '/%'};
    `;
    return result[0]?.total_bytes ?? BigInt(0);
  } catch {
    // storage.objects 不在 / 権限なし / Supabase 未連携環境 → null で fallback を促す
    return null;
  }
}

/**
 * テナント別 Attachment.sizeBytes SUM を集計 (= アプリ層の真値)。
 * storageProvider='supabase' かつ 未削除のみ対象。
 */
export async function calculateTenantAttachmentBytes(tenantId: string): Promise<bigint> {
  const agg = await prisma.attachment.aggregate({
    where: {
      tenantId: tenantId,
      storageProvider: 'supabase',
      deletedAt: null,
    },
    _sum: { sizeBytes: true },
  });
  return agg._sum.sizeBytes ?? BigInt(0);
}

// ============================================================
// テナント単位の同期 + anomaly 検知
// ============================================================

export interface SyncTenantFileStorageResult {
  tenantId: string;
  /** 採用された使用量 (= bucket 集計、失敗時は attachment SUM フォールバック) */
  usedBytes: bigint;
  /** Attachment SUM (= アプリ層の真値) */
  attachmentSumBytes: bigint;
  /** Supabase storage.objects 実容量 (取得失敗時 null) */
  bucketBytes: bigint | null;
  /** drift = (bucket - attachment) / attachment、attachment=0 の場合は 0 */
  driftRatio: number;
  /** peak 更新が発生したか */
  peakChanged: boolean;
  /** level 変化があったか (= 通知判定) */
  levelChanged: boolean;
  /** 新 warning level */
  newLevel: FileStorageWarningLevel;
  /** anomaly 検知 (24h で +5GB 以上) */
  anomalyDetected: boolean;
}

/**
 * 1 テナントの file storage 使用量を集計し Tenant 行を atomic 更新する。
 *
 *   1. bucket 集計 (= 主たる真値)、失敗時は Attachment SUM をフォールバック
 *   2. storageFileBytesUsed を更新、peak は MAX 同期
 *   3. fileStorageWarningLevel を classify、Level 昇格時のみ super_admin 通知
 *   4. anomaly 検知: storageFileBytesYesterday との差分 ≥ 5GB で警告
 *   5. storageBucketBytesPeakThisMonth (drift 用) を MAX 同期
 */
export async function syncTenantFileStorageUsage(
  tenantId: string,
): Promise<SyncTenantFileStorageResult> {
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      id: true,
      storageFileBytesPeakThisMonth: true,
      storageBucketBytesPeakThisMonth: true,
      fileStorageWarningLevel: true,
      storageFileBytesYesterday: true,
    },
  });
  if (!tenant) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }

  const [bucketBytes, attachmentSumBytes] = await Promise.all([
    calculateTenantBucketBytes(tenantId),
    calculateTenantAttachmentBytes(tenantId),
  ]);

  // 採用値: bucket が取れれば bucket、無理なら attachment SUM
  const usedBytes = bucketBytes ?? attachmentSumBytes;

  const currentPeak = tenant.storageFileBytesPeakThisMonth;
  const newPeak = usedBytes > currentPeak ? usedBytes : currentPeak;
  const peakChanged = usedBytes > currentPeak;

  const newLevel = classifyFileStorageLevel(newPeak);
  const levelChanged = newLevel !== tenant.fileStorageWarningLevel;

  // bucket peak (drift 用、bucket 取得成功時のみ)
  const currentBucketPeak = tenant.storageBucketBytesPeakThisMonth ?? BigInt(0);
  const bucketPeakChanged = bucketBytes !== null && bucketBytes > currentBucketPeak;
  const newBucketPeak = bucketPeakChanged ? bucketBytes! : tenant.storageBucketBytesPeakThisMonth;

  // anomaly: 24h で +5GB 以上 (storageFileBytesYesterday との差分)
  const yesterday = tenant.storageFileBytesYesterday;
  const anomalyDetected =
    yesterday !== null && usedBytes - yesterday >= BigInt(FILE_STORAGE_ANOMALY_DAILY_INCREASE_BYTES);

  // drift ratio (Attachment SUM 基準で bucket とのずれ)
  let driftRatio = 0;
  if (bucketBytes !== null && attachmentSumBytes > BigInt(0)) {
    const diff =
      bucketBytes > attachmentSumBytes
        ? bucketBytes - attachmentSumBytes
        : attachmentSumBytes - bucketBytes;
    driftRatio = Number(diff) / Number(attachmentSumBytes);
  }

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      storageFileBytesUsed: usedBytes,
      storageFileBytesUsedAt: new Date(),
      ...(peakChanged
        ? { storageFileBytesPeakThisMonth: usedBytes, storageFileBytesPeakAt: new Date() }
        : {}),
      ...(bucketPeakChanged ? { storageBucketBytesPeakThisMonth: newBucketPeak } : {}),
      ...(levelChanged ? { fileStorageWarningLevel: newLevel } : {}),
    },
  });

  // Level 昇格時のみ通知 (= spam 防止)
  if (peakChanged && levelChanged && newLevel !== 'none') {
    const order: Record<FileStorageWarningLevel, number> = { none: 0, l1: 1, l2: 2, l3: 3 };
    if (order[newLevel] > order[tenant.fileStorageWarningLevel as FileStorageWarningLevel]) {
      await recordError({
        severity: newLevel === 'l3' ? 'error' : newLevel === 'l2' ? 'warn' : 'info',
        source: 'cron',
        message: `[file-storage] Tenant ${tenantId} reached Level ${newLevel.toUpperCase()} via daily cron (peak=${Number(newPeak)} bytes)`,
        context: {
          kind: 'file_storage_warning',
          tenantId,
          peakBytes: Number(newPeak),
          previousLevel: tenant.fileStorageWarningLevel,
          newLevel,
          source: 'daily_cron',
        },
      });
    }
  }

  // anomaly 通知
  if (anomalyDetected) {
    await recordError({
      severity: 'warn',
      source: 'cron',
      message: `[file-storage] Tenant ${tenantId} daily increase exceeded ${FILE_STORAGE_ANOMALY_DAILY_INCREASE_BYTES} bytes (yesterday=${yesterday}, today=${usedBytes})`,
      context: {
        kind: 'file_storage_anomaly',
        tenantId,
        usedBytes: usedBytes.toString(),
        yesterdayBytes: yesterday?.toString() ?? null,
        increaseBytes: yesterday !== null ? (usedBytes - yesterday).toString() : null,
      },
    });
  }

  return {
    tenantId,
    usedBytes,
    attachmentSumBytes,
    bucketBytes,
    driftRatio,
    peakChanged,
    levelChanged,
    newLevel,
    anomalyDetected,
  };
}

// ============================================================
// 全テナント一括 (= 日次 cron エントリ)
// ============================================================

export interface UpdateAllFileStorageResult {
  updatedCount: number;
  anomalyCount: number;
  levelChangedCount: number;
}

/**
 * 全テナントの file storage 使用量を更新する (日次 cron 用)。
 * 1 テナントの失敗で全体は止めない。失敗は recordError + 集計のみ。
 *
 * 完了後、storageFileBytesYesterday を当日値で上書きする (= 翌日 anomaly 基準)。
 */
export async function updateAllTenantFileStorageUsage(): Promise<UpdateAllFileStorageResult> {
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });

  let updatedCount = 0;
  let anomalyCount = 0;
  let levelChangedCount = 0;

  for (const t of tenants) {
    try {
      const result = await syncTenantFileStorageUsage(t.id);
      updatedCount += 1;
      if (result.anomalyDetected) anomalyCount += 1;
      if (result.levelChanged) levelChangedCount += 1;

      // 翌日 anomaly 用の baseline 更新
      await prisma.tenant.update({
        where: { id: t.id },
        data: { storageFileBytesYesterday: result.usedBytes },
      });
    } catch (e) {
      try {
        await recordError({
          severity: 'error',
          source: 'cron',
          message: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
          context: { kind: 'file_storage_sync', tenantId: t.id },
        });
      } catch {
        // last-resort: ignore (error_logs テーブル不在等)
      }
    }
  }

  return { updatedCount, anomalyCount, levelChangedCount };
}

// ============================================================
// drift 検知 (全テナント横断)
// ============================================================

export interface FileStorageDriftResult {
  attachmentSumBytes: bigint;
  bucketSumBytes: bigint;
  driftRatio: number;
  driftLevel: 'ok' | 'warning' | 'critical';
}

/**
 * file storage 全テナント横断の drift 検知。
 *
 *   - Truth 1: 全テナント Attachment.sizeBytes SUM (storageProvider='supabase' 限定)
 *   - Truth 2: storage.objects 全 bucket SUM (bucket='attachments' 限定)
 *   - drift = |bucket - attachment| / attachment
 *   - 50%/100% で warning/critical alert
 *
 * 関連: feedback_drift_detection_design.md
 */
export async function detectFileStorageDrift(): Promise<FileStorageDriftResult> {
  // 1. cross-tenant 集計 (= 意図的に全テナント横断、cron で全テナントの drift を検知)。
  //    呼出側は super_admin / cron 経由のみ (= テナント越境 read リスクなし、aggregate は SUM のみ返却)。
  const attachAgg = await prisma.attachment.aggregate({
    where: { storageProvider: 'supabase', deletedAt: null },
    _sum: { sizeBytes: true },
  });
  const attachmentSumBytes = attachAgg._sum.sizeBytes ?? BigInt(0);

  // 2. storage.objects 全 bucket SUM
  let bucketSumBytes = BigInt(0);
  try {
    const r = await prisma.$queryRaw<Array<{ total_bytes: bigint | null }>>`
      SELECT COALESCE(SUM(((metadata->>'size')::bigint)), 0)::bigint AS total_bytes
        FROM storage.objects
       WHERE bucket_id = ${STORAGE_BUCKET};
    `;
    bucketSumBytes = r[0]?.total_bytes ?? BigInt(0);
  } catch (e) {
    await recordError({
      severity: 'warn',
      source: 'cron',
      message: '[file-storage-drift] storage.objects SUM failed (Supabase 未連携 or 権限不足)',
      context: {
        kind: 'file_storage_drift_detection',
        error: e instanceof Error ? e.message : String(e),
      },
    });
    // フォールバック: bucket 取れない場合は drift 計算不可 → ok 扱い (= attachment SUM のみ正)
    return {
      attachmentSumBytes,
      bucketSumBytes: BigInt(0),
      driftRatio: 0,
      driftLevel: 'ok',
    };
  }

  // 3. drift ratio
  let driftRatio = 0;
  if (attachmentSumBytes > BigInt(0)) {
    const diff =
      bucketSumBytes > attachmentSumBytes
        ? bucketSumBytes - attachmentSumBytes
        : attachmentSumBytes - bucketSumBytes;
    driftRatio = Number(diff) / Number(attachmentSumBytes);
  }

  const driftLevel: 'ok' | 'warning' | 'critical' =
    driftRatio >= FILE_STORAGE_DRIFT_CRITICAL_RATIO
      ? 'critical'
      : driftRatio >= FILE_STORAGE_DRIFT_WARNING_RATIO
        ? 'warning'
        : 'ok';

  if (driftLevel !== 'ok') {
    await recordError({
      severity: driftLevel === 'critical' ? 'error' : 'warn',
      source: 'cron',
      message: `[file-storage-drift] drift ${(driftRatio * 100).toFixed(1)}% (${driftLevel}): attachment=${attachmentSumBytes}, bucket=${bucketSumBytes}`,
      context: {
        kind: 'file_storage_drift_detection',
        driftLevel,
        driftRatio,
        attachmentSumBytes: attachmentSumBytes.toString(),
        bucketSumBytes: bucketSumBytes.toString(),
      },
    });
  }

  return { attachmentSumBytes, bucketSumBytes, driftRatio, driftLevel };
}
