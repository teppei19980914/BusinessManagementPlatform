/**
 * ストレージ容量 enforcement サービス (ADR-0020 / 2026-05-25 全面改修)
 *
 * 役割 (2026-05-31 改定 / ADR-0030「データはたすきばの命」):
 *   テナント配下のデータを作成 / 更新 / インポートする際の容量管理。
 *   **累積 50GB ハードキャップ (write 拒否) と circuit-breaker は撤廃**し、現在の役割は:
 *     (a) Beginner プラン無料枠 (DB 50MB / Storage 100MB) の write block
 *     (b) 月中 peak の計測 (課金根拠) + 監視アラート Level (L1/L2/L3) の更新
 *   累積による他テナント保護 (noisy-neighbor) は運用 (Supabase Compute 増強) で吸収する方針へ変更。
 *
 * 主要機能:
 *   1. **月中 peak (= max bytes) 計測**: write 経由で `storageBytesPeakThisMonth` を MAX 更新 (課金根拠)
 *   2. **監視アラート Level の自動分類**: 1GB(L1) / 10GB(L2) / 50GB(L3) — いずれも super_admin 通知用 (write は止めない)
 *   3. **Beginner 無料枠ガード**: Beginner プランのみ DB 50MB / Storage 100MB 超過で write 拒否 (overage 課金なし)
 *   4. **計測 fail-open**: DB 計測失敗時は write を止めず記録のみ (日次 cron `updateAllStorageBytesUsed` が補正)
 *   5. **動的計測** (R1): tenant-storage-tables.service へ委譲、新規テーブル自動追従
 *
 * 二段階チェック戦略:
 *   **Pre-check** (リクエスト入口、低コスト):
 *     - `Tenant.storageBytesUsed` キャッシュ + 推測サイズで Beginner 無料枠を判定 (超過なら 403)
 *
 *   **Post-check** (write コミット後の best-effort、正確):
 *     - 動的 SQL で `pg_column_size` 全テナント所属テーブルを集計
 *     - storageBytesUsed + storageBytesPeakThisMonth (MAX) を更新 (課金根拠 / billing invariant)
 *     - dbCapacityWarningLevel を classify 結果で更新 (通知 spam 防止)
 *     - Beginner が 50MB 超過なら BeginnerWriteGuardExceededError throw
 *     - 計測失敗は fail-open (記録のみ、日次 cron が補正)
 *
 * 関連:
 *   - ADR: docs/adr/0020-db-capacity-usage-based-billing.md
 *   - 単価/閾値: src/config/db-capacity-pricing.ts
 *   - 動的計測: src/services/tenant-storage-tables.service.ts
 *   - 月初請求: src/services/tenant-monthly-reset.service.ts (peak → ApiCallLog INSERT)
 *   - 退会時請求: src/services/tenant-withdrawal-billing.service.ts
 *   - middleware (suspended テナント拒否): 別経路 (本サービスはハードキャップのみ)
 *   - Memory: feedback_billing_invariant.md / feedback_tenant_isolation.md
 */

import type { PrismaClient } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';
import {
  BEGINNER_DB_FREE_TIER_BYTES,
  classifyDbCapacityLevel,
  type DbCapacityWarningLevel,
} from '@/config/db-capacity-pricing';
import {
  BEGINNER_STORAGE_FREE_TIER_BYTES,
  classifyFileStorageLevel,
  type FileStorageWarningLevel,
} from '@/config/file-storage-pricing';
import { calculateTenantStorageBytesDynamic } from '@/services/tenant-storage-tables.service';
import { recordError } from '@/services/error-log.service';

/** Prisma transaction client (PrismaClient の transaction 内コールバック引数) */
export type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

// 2026-05-31: StorageLimitExceededError (DB 50GB 累積ハードキャップ例外) は撤去 (ADR-0030)。
//   累積による write 拒否を廃止したため。Beginner 無料枠ガードは BeginnerWriteGuardExceededError を使用。

/**
 * Beginner プラン無料枠超過 write ブロック例外 (ADR-0025、2026-05-29)。
 *
 * Beginner プランのテナントが DB 50MB / File Storage 100MB を超過した状態で
 * INSERT / UPDATE を実行しようとした際に throw される。ハードキャップ (50GB) とは
 * 別ロジックで、Beginner プランのみ対象。
 *
 * - quotaType='db': DB 容量超過 (BEGINNER_DB_FREE_TIER_BYTES=50MB)
 * - quotaType='storage': File Storage 容量超過 (BEGINNER_STORAGE_FREE_TIER_BYTES=100MB)
 *
 * 呼出側 API は本例外を catch して mapBeginnerWriteGuardErrorToResponse() で
 * HTTP 403 + Beginner 専用エラー文言で応答する。
 */
export class BeginnerWriteGuardExceededError extends Error {
  readonly code: 'BEGINNER_DB_QUOTA_EXCEEDED' | 'BEGINNER_STORAGE_QUOTA_EXCEEDED';
  readonly quotaType: 'db' | 'storage';
  readonly currentBytes: number;
  readonly limitBytes: number;

  constructor(args: {
    tenantId: string;
    quotaType: 'db' | 'storage';
    currentBytes: number;
    limitBytes: number;
  }) {
    super(
      `Tenant ${args.tenantId} (beginner plan) ${args.quotaType} usage ${args.currentBytes} bytes exceeds free tier ${args.limitBytes} bytes (ADR-0025)`,
    );
    this.name = 'BeginnerWriteGuardExceededError';
    this.code =
      args.quotaType === 'db'
        ? 'BEGINNER_DB_QUOTA_EXCEEDED'
        : 'BEGINNER_STORAGE_QUOTA_EXCEEDED';
    this.quotaType = args.quotaType;
    this.currentBytes = args.currentBytes;
    this.limitBytes = args.limitBytes;
  }
}

// 2026-05-31: StorageGuardCircuitOpenError (circuit-breaker fail-close) は撤去 (ADR-0030)。
//   累積ハードキャップが無くなり「計測できないから write 拒否」の根拠が消えたため。
//   計測失敗は fail-open (記録のみ) とし、日次 cron が真値を補正する。

// ================================================================
// Pre-check (低コスト)
// ================================================================

/**
 * **Pre-check** — リクエスト入口でハードキャップに明らかに到達するかを低コストに判定。
 *
 * - キャッシュ値 (storageBytesUsed) + 推測サイズで判定
 * - キャッシュは write 経由で更新される (= 一般利用者の write は確実に新鮮)
 * - 真の境界は Post-check が担保
 *
 * @param tenantId 対象テナント
 * @param estimatedNewBytes 追加見込みバイト数 (= payload サイズ等の推測値)
 * @returns ok=true なら継続、false なら即時拒否
 */
export async function precheckStorageLimit(
  tenantId: string,
  estimatedNewBytes: number,
): Promise<
  | { ok: true; cachedUsedBytes: number; limitBytes: number }
  | {
      ok: false;
      code: 'BEGINNER_DB_QUOTA_EXCEEDED';
      cachedUsedBytes: number;
      limitBytes: number;
    }
> {
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    // ADR-0025 (2026-05-29): Beginner プラン判定のため plan を select に追加。
    //   既存 select に追加するだけで N+1 にはならない (= 同じ findFirst 1 回)。
    select: {
      plan: true,
      storageBytesUsed: true,
    },
  });
  if (!tenant) {
    // テナント不在 → 上位で 401/404 が出ているはずだが defensive に通す (404 を Pre-check で扱わない)
    return { ok: true, cachedUsedBytes: 0, limitBytes: BEGINNER_DB_FREE_TIER_BYTES };
  }

  const cachedUsedBytes = Number(tenant.storageBytesUsed);

  // ADR-0025: Beginner プラン専用 50MB 無料枠ガード。
  //   ADR-0019 / ADR-0022 の「90 日完全無料」訴求を保証するため、Beginner プランは
  //   50MB 超過状態で INSERT/UPDATE を一律拒否し、overage 課金も発生させない。
  //   DELETE は許可 (= storage-guard を通らないため自動的に許可される)。
  //   詳細: docs/adr/0025-beginner-write-guard.md
  //
  // 2026-05-31: 累積 50GB ハードキャップ撤去 (ADR-0030「データはたすきばの命」)。
  //   全プラン共通の write block は廃止し、Beginner 無料枠ガードのみ残す。
  //   circuit-breaker (計測失敗時の write 拒否) も撤去 (計測は日次 cron が補正)。
  if (
    tenant.plan === 'beginner' &&
    cachedUsedBytes + estimatedNewBytes > BEGINNER_DB_FREE_TIER_BYTES
  ) {
    return {
      ok: false,
      code: 'BEGINNER_DB_QUOTA_EXCEEDED',
      cachedUsedBytes,
      limitBytes: BEGINNER_DB_FREE_TIER_BYTES,
    };
  }

  return { ok: true, cachedUsedBytes, limitBytes: BEGINNER_DB_FREE_TIER_BYTES };
}

// ================================================================
// Post-check (transaction 内、正確 + peak update + warning level + circuit breaker)
// ================================================================

/**
 * **Post-check (2026-05-31 改定)** — ユーザのデータ書込が**別 tx で既にコミットされた後**に、
 * best-effort で使用量を再計測して peak/level を更新し、Beginner 無料枠を post-check する:
 *
 *   1. SELECT FOR UPDATE で tenant 行ロック
 *   2. 動的 SQL (`calculateTenantStorageBytesDynamic`) で実使用量を集計
 *   3. `storageBytesUsed` + `storageBytesPeakThisMonth` (MAX) を更新 (課金根拠 / billing invariant)
 *   4. `dbCapacityWarningLevel` を classify 結果で更新 (`none` / `l1` / `l2` / `l3` = 監視アラート閾値)
 *   5. Beginner プランが 50MB 無料枠を超えていれば `BeginnerWriteGuardExceededError` throw
 *   6. **計測失敗時は fail-open** (= recordError + return、write は止めない。日次 cron が補正)
 *
 *   ※ 累積 50GB ハードキャップ (旧 §5b) と circuit-breaker は撤去済 (ADR-0030)。
 *
 * 呼出側パターン (write コミット後に別 tx で呼ぶ):
 *   ```ts
 *   const result = await prisma.$transaction((tx) => tx.knowledge.create({...})); // 書込コミット
 *   try {
 *     await prisma.$transaction((tx) => assertStorageLimitInTx(tx, tenantId));    // best-effort
 *   } catch (e) {
 *     // Beginner 超過は呼出側で UX 文言にマッピング。計測失敗等はログのみで握りつぶす。
 *   }
 *   ```
 *
 * @throws BeginnerWriteGuardExceededError Beginner プランが 50MB 無料枠超過時 (計測成功時のみ)
 */
export async function assertStorageLimitInTx(
  tx: TxClient,
  tenantId: string,
): Promise<void> {
  // 1. SELECT FOR UPDATE で tenant 行ロック (R8/R9 並列 write 直列化)
  //    pgcrypto の advisory lock より row-level lock の方が transaction scope で自然
  await (tx as unknown as { $queryRaw: typeof prisma.$queryRaw }).$queryRaw`
    SELECT id FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE
  `;

  const tenant = await tx.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      id: true,
      // ADR-0025 (2026-05-29): Beginner プラン判定のため plan を select に追加
      plan: true,
      storageBytesPeakThisMonth: true,
      dbCapacityWarningLevel: true,
    },
  });
  if (!tenant) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }

  // 2. 動的 SQL で実測 (= R1 計測対象の網羅性保証)
  let usedBytes: bigint;
  try {
    usedBytes = await calculateTenantStorageBytesDynamic(tenantId, tx);
  } catch (e) {
    // 2026-05-31 fail-open (ADR-0030「データはたすきばの命」):
    //   累積 50GB ハードキャップ撤去に伴い circuit-breaker (fail-close) も廃止。
    //   計測失敗時は write を止めず、peak 更新を skip して記録のみ残す。真値は日次 cron
    //   `updateAllStorageBytesUsed` が再計測して補正する (= 課金は月内 MAX なので取りこぼさない)。
    //   ※ 本関数は「ユーザのデータ書込が別 tx で既にコミットされた後」に呼ばれる前提。
    //     計測クエリ失敗で本 tx が abort しても、コミット済のユーザ書込には影響しない
    //     (呼出側はこの計測 tx の失敗をログのみで握りつぶす)。
    await recordError({
      severity: 'warn',
      source: 'server',
      message: `[storage-guard] DB usage 計測失敗 (fail-open, tenant=${tenantId})`,
      stack: e instanceof Error ? e.stack : undefined,
      context: {
        kind: 'storage_guard_measure_failed',
        tenantId,
        originalError: e instanceof Error ? e.message : String(e),
      },
    });
    return;
  }

  // 3-4. peak / warning level / cache を atomic 更新
  const usedBytesNumber = Number(usedBytes);
  const currentPeak = tenant.storageBytesPeakThisMonth;
  const newPeak = usedBytes > currentPeak ? usedBytes : currentPeak;
  const peakChanged = usedBytes > currentPeak;
  const newLevel: DbCapacityWarningLevel = classifyDbCapacityLevel(newPeak);
  const levelChanged = newLevel !== tenant.dbCapacityWarningLevel;

  await tx.tenant.update({
    where: { id: tenantId },
    data: {
      storageBytesUsed: usedBytes,
      storageBytesUsedAt: new Date(),
      ...(peakChanged
        ? { storageBytesPeakThisMonth: usedBytes, storageBytesPeakAt: new Date() }
        : {}),
      ...(levelChanged ? { dbCapacityWarningLevel: newLevel } : {}),
    },
  });

  // Level 昇格時のみ super_admin に通知 (= 通知 spam 防止 / R12)
  if (levelChanged && newLevel !== 'none' && shouldNotifyAdmin(newLevel, tenant.dbCapacityWarningLevel as DbCapacityWarningLevel)) {
    await recordError({
      severity: newLevel === 'l3' ? 'error' : newLevel === 'l2' ? 'warn' : 'info',
      source: 'server',
      message: `[db-capacity] Tenant ${tenantId} reached Level ${newLevel.toUpperCase()} (peak=${usedBytesNumber} bytes)`,
      context: {
        kind: 'db_capacity_warning',
        tenantId,
        peakBytes: usedBytesNumber,
        previousLevel: tenant.dbCapacityWarningLevel,
        newLevel,
      },
    });
  }

  // 5a. ADR-0025 (2026-05-29): Beginner プラン 50MB 無料枠ガード (ハードキャップ判定より優先)。
  //   ADR-0019 / ADR-0022 の「90 日完全無料」訴求を保証するため、Beginner プランは
  //   50MB 超過状態で INSERT/UPDATE を一律拒否し、overage 課金も発生させない。
  //   DELETE は storage-guard を通らないため自動的に許可される。
  //   詳細: docs/adr/0025-beginner-write-guard.md / docs/specification/BEGINNER_PLAN.md
  if (tenant.plan === 'beginner' && usedBytes > BigInt(BEGINNER_DB_FREE_TIER_BYTES)) {
    throw new BeginnerWriteGuardExceededError({
      tenantId,
      quotaType: 'db',
      currentBytes: usedBytesNumber,
      limitBytes: BEGINNER_DB_FREE_TIER_BYTES,
    });
  }

  // 2026-05-31: 旧 §5b の 50GB 累積ハードキャップ write 拒否は撤去 (ADR-0030「データはたすきばの命」)。
  //   L3 (50GB) は上記 classify による super_admin 監視アラート閾値としてのみ機能する (write は止めない)。
}

/**
 * Level 昇格 (none→l1, l1→l2, l1→l3 等) の場合のみ super_admin 通知。
 * 横ばい / 降格時は通知しない (spam 防止)。
 */
function shouldNotifyAdmin(
  newLevel: DbCapacityWarningLevel,
  oldLevel: DbCapacityWarningLevel,
): boolean {
  const order: Record<DbCapacityWarningLevel, number> = { none: 0, l1: 1, l2: 2, l3: 3 };
  return order[newLevel] > order[oldLevel];
}

// ================================================================
// withStorageGuard — $transaction + Post-check の一括 wrapper
// ================================================================

/**
 * fn の中で書込操作を行い、その直後に `assertStorageLimitInTx` を実行する。
 *
 * ```ts
 * // 修正前
 * await prisma.project.create({ data: {...} });
 *
 * // 修正後
 * await withStorageGuard(tenantId, (tx) => tx.project.create({ data: {...} }));
 * ```
 */
export async function withStorageGuard<T>(
  tenantId: string,
  fn: (tx: TxClient) => Promise<T>,
  options?: { timeout?: number; maxWait?: number },
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      const result = await fn(tx);
      await assertStorageLimitInTx(tx, tenantId);
      return result;
    },
    {
      timeout: options?.timeout ?? 30_000,
      maxWait: options?.maxWait ?? 5_000,
    },
  );
}

// ================================================================
// エラーマッピング — API route から共通利用
// ================================================================

// 2026-05-31: mapStorageGuardErrorToResponse (STORAGE_LIMIT_EXCEEDED / STORAGE_GUARD_CIRCUIT_OPEN
//   のレスポンスマッピング) は撤去 (ADR-0030)。累積ハードキャップ撤廃で対象エラーが無くなったため。
//   Beginner 無料枠超過は mapBeginnerWriteGuardErrorToResponse を使用する。

// ================================================================
// ファイルストレージ Pre-check / Post-check (ADR-0021 §10.7)
// ================================================================

// 2026-05-31: FileStorageLimitExceededError (ファイル 50GB 累積ハードキャップ例外) は撤去 (ADR-0030)。
//   ファイルは Supabase Storage (オブジェクトストレージ) で Postgres RAM 非依存のため累積上限を撤廃。
//   1 ファイル上限 50MB は upload/finalize route 側の FILE_STORAGE_MAX_FILE_SIZE_BYTES 検証で担保。

/**
 * Pre-check — Pre-signed URL 発行前にハードキャップ判定。
 *
 * - cache (storageFileBytesUsed) + 申告サイズで判定
 * - 真値は finalize 時の Post-check で再担保
 * - DB 容量と異なり「動的計測コスト」が高い (Supabase API 呼出) ため、
 *   キャッシュ + post-check で十分とする (= drift は daily cron で補正)
 *
 * @param tenantId 対象テナント
 * @param estimatedNewBytes アップロード予定サイズ
 */
export async function precheckFileStorageLimit(
  tenantId: string,
  estimatedNewBytes: number,
): Promise<
  | { ok: true; cachedUsedBytes: number; limitBytes: number }
  | {
      ok: false;
      code: 'BEGINNER_STORAGE_QUOTA_EXCEEDED';
      cachedUsedBytes: number;
      limitBytes: number;
    }
> {
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    // ADR-0025 (2026-05-29): Beginner プラン判定のため plan を select に追加
    select: { plan: true, storageFileBytesUsed: true },
  });
  if (!tenant) {
    return { ok: true, cachedUsedBytes: 0, limitBytes: BEGINNER_STORAGE_FREE_TIER_BYTES };
  }

  const cachedUsedBytes = Number(tenant.storageFileBytesUsed);

  // ADR-0025: Beginner プラン専用 100MB 無料枠ガード。
  //   Pre-signed URL 発行前の判定。Beginner プランは 100MB 超過状態でアップロード拒否、
  //   overage 課金も発生させない。File 削除は許可 (assertFileStorageLimitInTx で
  //   addedBytes < 0 のときは Beginner ガード判定を skip する)。
  //   詳細: docs/adr/0025-beginner-write-guard.md / docs/specification/BEGINNER_PLAN.md
  //
  // 2026-05-31: 累積 50GB ハードキャップ撤去 (ADR-0030)。ファイルは Supabase Storage
  //   (オブジェクトストレージ) で Postgres RAM 非依存のため noisy-neighbor とも無関係。
  //   1 ファイル上限 50MB (FILE_STORAGE_MAX_FILE_SIZE_BYTES) は upload/finalize route 側で別途検証。
  if (
    tenant.plan === 'beginner' &&
    cachedUsedBytes + estimatedNewBytes > BEGINNER_STORAGE_FREE_TIER_BYTES
  ) {
    return {
      ok: false,
      code: 'BEGINNER_STORAGE_QUOTA_EXCEEDED',
      cachedUsedBytes,
      limitBytes: BEGINNER_STORAGE_FREE_TIER_BYTES,
    };
  }

  return { ok: true, cachedUsedBytes, limitBytes: BEGINNER_STORAGE_FREE_TIER_BYTES };
}

/**
 * Post-check — transaction 内でファイルストレージ集計を atomic 更新。
 *
 *   1. SELECT FOR UPDATE で tenant 行ロック
 *   2. storageFileBytesUsed += addedBytes (delete の場合は負値で減算)
 *   3. storageFileBytesPeakThisMonth = MAX(現値, 新使用量)
 *   4. fileStorageWarningLevel を classify 結果で更新 (= 通知 spam 防止 / L3=50GB は監視アラート閾値)
 *   5. Beginner プランが 100MB 無料枠超過なら BeginnerWriteGuardExceededError throw
 *      (2026-05-31: 50GB 累積ハードキャップ throw は撤去、ADR-0030)
 *
 * 呼出側パターン (POST /api/attachments/finalize):
 *   ```ts
 *   await prisma.$transaction(async (tx) => {
 *     await tx.attachment.create({ data: { sizeBytes, ... } });
 *     await assertFileStorageLimitInTx(tx, tenantId, sizeBytes);
 *   });
 *   ```
 *
 * @param tx Prisma transaction client
 * @param tenantId 対象テナント
 * @param addedBytes 増減バイト数 (アップロード時 +n、削除時 -n)
 *
 * @throws BeginnerWriteGuardExceededError Beginner プランが 100MB 無料枠超過時 (アップロード時のみ)
 */
export async function assertFileStorageLimitInTx(
  tx: TxClient,
  tenantId: string,
  addedBytes: number,
): Promise<void> {
  await (tx as unknown as { $queryRaw: typeof prisma.$queryRaw }).$queryRaw`
    SELECT id FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE
  `;

  const tenant = await tx.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      id: true,
      // ADR-0025 (2026-05-29): Beginner プラン判定のため plan を select に追加
      plan: true,
      storageFileBytesUsed: true,
      storageFileBytesPeakThisMonth: true,
      fileStorageWarningLevel: true,
    },
  });
  if (!tenant) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }

  const currentUsed = tenant.storageFileBytesUsed;
  const added = BigInt(addedBytes);
  const newUsed = currentUsed + added;
  const safeNewUsed = newUsed < BigInt(0) ? BigInt(0) : newUsed;
  const currentPeak = tenant.storageFileBytesPeakThisMonth;
  const newPeak = safeNewUsed > currentPeak ? safeNewUsed : currentPeak;
  const peakChanged = safeNewUsed > currentPeak;
  const newLevel: FileStorageWarningLevel = classifyFileStorageLevel(newPeak);
  const levelChanged = newLevel !== tenant.fileStorageWarningLevel;

  await tx.tenant.update({
    where: { id: tenantId },
    data: {
      storageFileBytesUsed: safeNewUsed,
      storageFileBytesUsedAt: new Date(),
      ...(peakChanged
        ? { storageFileBytesPeakThisMonth: safeNewUsed, storageFileBytesPeakAt: new Date() }
        : {}),
      ...(levelChanged ? { fileStorageWarningLevel: newLevel } : {}),
    },
  });

  if (
    levelChanged &&
    newLevel !== 'none' &&
    shouldNotifyFileStorageAdmin(newLevel, tenant.fileStorageWarningLevel as FileStorageWarningLevel)
  ) {
    await recordError({
      severity: newLevel === 'l3' ? 'error' : newLevel === 'l2' ? 'warn' : 'info',
      source: 'server',
      message: `[file-storage] Tenant ${tenantId} reached Level ${newLevel.toUpperCase()} (peak=${Number(newPeak)} bytes)`,
      context: {
        kind: 'file_storage_warning',
        tenantId,
        peakBytes: Number(newPeak),
        previousLevel: tenant.fileStorageWarningLevel,
        newLevel,
      },
    });
  }

  // ADR-0025 (2026-05-29): Beginner プラン 100MB 無料枠ガード (ハードキャップ判定より優先)。
  //   addedBytes > 0 (= アップロード) のときのみ判定。addedBytes < 0 (= ファイル削除) は
  //   容量を減らす方向のため Beginner ガード対象外 (DELETE 許可ポリシー)。
  //   詳細: docs/adr/0025-beginner-write-guard.md / docs/specification/BEGINNER_PLAN.md
  if (
    tenant.plan === 'beginner' &&
    addedBytes > 0 &&
    safeNewUsed > BigInt(BEGINNER_STORAGE_FREE_TIER_BYTES)
  ) {
    throw new BeginnerWriteGuardExceededError({
      tenantId,
      quotaType: 'storage',
      currentBytes: Number(safeNewUsed),
      limitBytes: BEGINNER_STORAGE_FREE_TIER_BYTES,
    });
  }

  // 2026-05-31: 50GB 累積ハードキャップ (アップロード拒否) は撤去 (ADR-0030)。
  //   L3 (50GB) は上記 classify による super_admin 監視アラート閾値としてのみ機能する。
}

function shouldNotifyFileStorageAdmin(
  newLevel: FileStorageWarningLevel,
  oldLevel: FileStorageWarningLevel,
): boolean {
  const order: Record<FileStorageWarningLevel, number> = { none: 0, l1: 1, l2: 2, l3: 3 };
  return order[newLevel] > order[oldLevel];
}

/**
 * ファイルストレージエラーの API レスポンスマッピング。
 */
/**
 * ADR-0025 (2026-05-29): Beginner プラン write guard エラーの API レスポンスマッピング。
 *
 * BeginnerWriteGuardExceededError を catch し、HTTP 403 + Beginner 専用 UX 文言で応答する。
 * 既存 mapStorageGuardErrorToResponse / mapFileStorageGuardErrorToResponse とは別マッパーとし、
 * 呼出側で順番に try する設計 (= 既存エラーマッパーは未改変、後方互換維持)。
 *
 * 呼出パターン:
 *   ```ts
 *   try {
 *     await withStorageGuard(tenantId, (tx) => tx.knowledge.create(...));
 *   } catch (e) {
 *     const beginner = mapBeginnerWriteGuardErrorToResponse(e);
 *     if (beginner) return NextResponse.json(beginner.body, { status: beginner.status });
 *     throw e;
 *   }
 *   ```
 *
 * UX 文言は ADR-0025 §4.1 で確定済の統一メッセージを使用 (3 経路 = トースト/API/フォーム 統一)。
 */
export function mapBeginnerWriteGuardErrorToResponse(error: unknown):
  | {
      status: 403;
      body: {
        error: {
          code: 'BEGINNER_DB_QUOTA_EXCEEDED' | 'BEGINNER_STORAGE_QUOTA_EXCEEDED';
          message: string;
          quotaType: 'db' | 'storage';
          currentBytes: number;
          limitBytes: number;
          upgradeUrl: string;
        };
      };
    }
  | null {
  if (error instanceof BeginnerWriteGuardExceededError) {
    return {
      status: 403,
      body: {
        error: {
          code: error.code,
          message:
            'Beginner プランの無料枠 (DB 50MB / Storage 100MB) を超えました。不要なデータを削除する、または Expert プランへアップグレードしてください。',
          quotaType: error.quotaType,
          currentBytes: error.currentBytes,
          limitBytes: error.limitBytes,
          upgradeUrl: '/settings/tenant',
        },
      },
    };
  }
  return null;
}

// 2026-05-31: mapFileStorageGuardErrorToResponse (STORAGE_FILE_HARD_CAP_EXCEEDED マッピング) は撤去 (ADR-0030)。
//   累積ハードキャップ撤廃で対象エラーが無くなったため。Beginner 超過は mapBeginnerWriteGuardErrorToResponse を使用。
