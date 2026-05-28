/**
 * ストレージ容量 enforcement サービス (ADR-0020 / 2026-05-25 全面改修)
 *
 * 役割:
 *   テナント配下のデータを作成 / 更新 / インポートする際、
 *   ADR-0020 で定めた **50GB ハードキャップ** を超えないことをリアルタイムで保証する。
 *   ハードキャップは「他テナントへの影響を絶対不許容」原則 (R3) の技術的安全弁。
 *
 * 主要機能 (ADR-0020):
 *   1. **月中 peak (= max bytes) 計測**: write 経由で `storageBytesPeakThisMonth` を MAX 更新
 *   2. **4 層防御 warning Level の自動分類**: 1GB / 10GB / 50GB / instance-wide
 *   3. **50GB ハードキャップ**: 超過時に write 拒否 (read / export は別ロジックで許可)
 *   4. **fail-close + circuit breaker** (R3): 計測失敗時は write 拒否、3 回連続失敗で long open
 *   5. **並列性制御** (R8/R9): SELECT FOR UPDATE で同テナント並列 write を直列化
 *   6. **動的計測** (R1): tenant-storage-tables.service へ委譲、新規テーブル自動追従
 *
 * 旧仕様からの変更 (R4):
 *   - 4 段階 addon プラン (Standard 20MB / Plus 220MB / Pro 1.02GB / Enterprise 5.02GB) は廃止
 *   - 7 日 Grace period も廃止 (= 即時 hard cap 判定のみ)
 *   - 旧上限は env DB_CAPACITY_L3_HARD_CAP_BYTES で上書き可能だが default 50GB SI
 *
 * 二段階チェック戦略 (旧仕様から継承、ロジック更新):
 *   **Pre-check** (リクエスト入口、低コスト):
 *     - `Tenant.storageBytesUsed` キャッシュ + 推測サイズで判定
 *     - 明らかにハードキャップ超過なら 413 で即時拒否
 *
 *   **Post-check** (transaction 内、正確):
 *     - SELECT FOR UPDATE で tenant 行ロック (並列 write race 防止)
 *     - 動的 SQL で `pg_column_size` 全テナント所属テーブルを集計
 *     - storageBytesUsed + storageBytesPeakThisMonth (MAX) を atomic 更新
 *     - dbCapacityWarningLevel を classify 結果で更新 (通知 spam 防止)
 *     - 50GB 超過なら StorageLimitExceededError throw
 *     - 計測失敗時は circuitBreakerFailCount を increment、3 回で long open
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
  DB_CAPACITY_L3_HARD_CAP_BYTES,
  STORAGE_GUARD_CIRCUIT_BREAKER_THRESHOLD,
  classifyDbCapacityLevel,
  type DbCapacityWarningLevel,
} from '@/config/db-capacity-pricing';
import {
  BEGINNER_STORAGE_FREE_TIER_BYTES,
  FILE_STORAGE_L3_HARD_CAP_BYTES,
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

/**
 * ハードキャップ (50GB) 超過時に投げる例外。
 * transaction 内で throw すれば全件ロールバックされる。
 * 呼出側 API は本例外を catch して 403 STORAGE_LIMIT_EXCEEDED で応答する。
 *
 * 旧 addonPlan フィールドは ADR-0020 で 4 段階プラン廃止のため除去。
 */
export class StorageLimitExceededError extends Error {
  readonly code = 'STORAGE_LIMIT_EXCEEDED';
  readonly currentBytes: number;
  readonly limitBytes: number;

  constructor(args: { tenantId: string; currentBytes: number; limitBytes: number }) {
    super(
      `Tenant ${args.tenantId} storage usage ${args.currentBytes} bytes exceeds hard cap ${args.limitBytes} bytes`,
    );
    this.name = 'StorageLimitExceededError';
    this.currentBytes = args.currentBytes;
    this.limitBytes = args.limitBytes;
  }
}

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

/**
 * Circuit breaker open 中に投げる例外 (R3 fail-close)。
 * 連続 STORAGE_GUARD_CIRCUIT_BREAKER_THRESHOLD 回 (= 3) 失敗で発火、super_admin の手動復旧待ち。
 */
export class StorageGuardCircuitOpenError extends Error {
  readonly code = 'STORAGE_GUARD_CIRCUIT_OPEN';
  readonly tenantId: string;
  readonly failCount: number;

  constructor(args: { tenantId: string; failCount: number }) {
    super(
      `Storage guard circuit open for tenant ${args.tenantId} (failCount=${args.failCount}), refusing write to protect data integrity`,
    );
    this.name = 'StorageGuardCircuitOpenError';
    this.tenantId = args.tenantId;
    this.failCount = args.failCount;
  }
}

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
      code: 'STORAGE_LIMIT_EXCEEDED' | 'BEGINNER_DB_QUOTA_EXCEEDED';
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
      storageGuardCircuitOpenedAt: true,
    },
  });
  if (!tenant) {
    // テナント不在 → 上位で 401/404 が出ているはずだが defensive に通す (404 を Pre-check で扱わない)
    return { ok: true, cachedUsedBytes: 0, limitBytes: DB_CAPACITY_L3_HARD_CAP_BYTES };
  }

  // Circuit open 中は早期に拒否 (= fail-close)
  if (tenant.storageGuardCircuitOpenedAt != null) {
    return {
      ok: false,
      code: 'STORAGE_LIMIT_EXCEEDED',
      cachedUsedBytes: Number(tenant.storageBytesUsed),
      limitBytes: DB_CAPACITY_L3_HARD_CAP_BYTES,
    };
  }

  const cachedUsedBytes = Number(tenant.storageBytesUsed);

  // ADR-0025: Beginner プラン専用 50MB 無料枠ガード (ハードキャップ判定より優先)。
  //   ADR-0019 / ADR-0022 の「90 日完全無料」訴求を保証するため、Beginner プランは
  //   50MB 超過状態で INSERT/UPDATE を一律拒否し、overage 課金も発生させない。
  //   DELETE は許可 (= storage-guard を通らないため自動的に許可される)。
  //   詳細: docs/adr/0025-beginner-write-guard.md
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

  if (cachedUsedBytes + estimatedNewBytes > DB_CAPACITY_L3_HARD_CAP_BYTES) {
    return {
      ok: false,
      code: 'STORAGE_LIMIT_EXCEEDED',
      cachedUsedBytes,
      limitBytes: DB_CAPACITY_L3_HARD_CAP_BYTES,
    };
  }
  return { ok: true, cachedUsedBytes, limitBytes: DB_CAPACITY_L3_HARD_CAP_BYTES };
}

// ================================================================
// Post-check (transaction 内、正確 + peak update + warning level + circuit breaker)
// ================================================================

/**
 * **Post-check** — transaction 内で実測値を計算し、以下を atomic に実施:
 *
 *   1. SELECT FOR UPDATE で tenant 行ロック (R8/R9: 並列 write race 防止)
 *   2. 動的 SQL (`calculateTenantStorageBytesDynamic`) で実使用量を集計
 *   3. `storageBytesUsed` + `storageBytesPeakThisMonth` (MAX) を atomic 更新
 *   4. `dbCapacityWarningLevel` を classify 結果で更新 (`none` / `l1` / `l2` / `l3`)
 *   5. ハードキャップ (50GB) 超過なら `StorageLimitExceededError` throw (= tx 全件ロールバック)
 *   6. 計測失敗時は `storageGuardCircuitFailCount` increment、3 回連続で circuit open
 *
 * 呼出側パターン:
 *   ```ts
 *   await prisma.$transaction(async (tx) => {
 *     await tx.knowledge.create({...});
 *     await assertStorageLimitInTx(tx, tenantId);  // 書込直後
 *   });
 *   ```
 *
 * @throws StorageLimitExceededError ハードキャップ超過時
 * @throws StorageGuardCircuitOpenError circuit breaker open 中の場合
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
      storageGuardCircuitFailCount: true,
      storageGuardCircuitOpenedAt: true,
      dbCapacityWarningLevel: true,
    },
  });
  if (!tenant) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }

  // Circuit breaker が open 中なら即時拒否 (= fail-close)
  if (tenant.storageGuardCircuitOpenedAt != null) {
    throw new StorageGuardCircuitOpenError({
      tenantId,
      failCount: tenant.storageGuardCircuitFailCount,
    });
  }

  // 2. 動的 SQL で実測 (= R1 計測対象の網羅性保証)
  let usedBytes: bigint;
  try {
    usedBytes = await calculateTenantStorageBytesDynamic(tenantId, tx);
  } catch (e) {
    // R3 fail-close: 計測失敗時は counter increment、threshold で circuit open
    const newFailCount = tenant.storageGuardCircuitFailCount + 1;
    const shouldOpenCircuit = newFailCount >= STORAGE_GUARD_CIRCUIT_BREAKER_THRESHOLD;

    await tx.tenant.update({
      where: { id: tenantId },
      data: {
        storageGuardCircuitFailCount: newFailCount,
        storageGuardCircuitOpenedAt: shouldOpenCircuit ? new Date() : null,
      },
    });

    // super_admin に緊急アラート (recordError 経由 / R12-admin)
    await recordError({
      severity: shouldOpenCircuit ? 'error' : 'warn',
      source: 'server',
      message: shouldOpenCircuit
        ? `[storage-guard] CIRCUIT OPEN (tenant=${tenantId}, failCount=${newFailCount})`
        : `[storage-guard] measurement failed (tenant=${tenantId}, failCount=${newFailCount})`,
      stack: e instanceof Error ? e.stack : undefined,
      context: {
        kind: 'storage_guard_circuit',
        tenantId,
        failCount: newFailCount,
        circuitOpened: shouldOpenCircuit,
        originalError: e instanceof Error ? e.message : String(e),
      },
    });

    // fail-close: 計測できない以上、write は通せない (= 他テナント保護の絶対原則 R3)
    throw new StorageLimitExceededError({
      tenantId,
      currentBytes: 0,
      limitBytes: DB_CAPACITY_L3_HARD_CAP_BYTES,
    });
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
      // 計測成功時は circuit breaker counter リセット
      ...(tenant.storageGuardCircuitFailCount > 0
        ? { storageGuardCircuitFailCount: 0 }
        : {}),
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

  // 5b. ハードキャップ判定 (全プラン共通、Beginner は §5a で先に弾かれる)
  if (usedBytes > BigInt(DB_CAPACITY_L3_HARD_CAP_BYTES)) {
    throw new StorageLimitExceededError({
      tenantId,
      currentBytes: usedBytesNumber,
      limitBytes: DB_CAPACITY_L3_HARD_CAP_BYTES,
    });
  }
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

/**
 * API route の error handling を簡潔にするためのヘルパ。
 *
 * ```ts
 * try {
 *   await withStorageGuard(tenantId, (tx) => tx.project.create(...));
 *   return NextResponse.json({ data: ... });
 * } catch (e) {
 *   const r = mapStorageGuardErrorToResponse(e);
 *   if (r) return r;
 *   throw e;
 * }
 * ```
 *
 * ADR-0020 (R13) ハードキャップエラーメッセージ:
 *   - read / export は別経路で許可される旨を伝える
 *   - サポート問い合わせは v1.x で個別契約フロー検討予定 (今は記載なし)
 */
export function mapStorageGuardErrorToResponse(error: unknown):
  | {
      status: 403;
      body: {
        error: {
          code: 'STORAGE_LIMIT_EXCEEDED' | 'STORAGE_GUARD_CIRCUIT_OPEN';
          message: string;
          currentBytes?: number;
          limitBytes?: number;
        };
      };
    }
  | null {
  if (error instanceof StorageLimitExceededError) {
    return {
      status: 403,
      body: {
        error: {
          code: 'STORAGE_LIMIT_EXCEEDED',
          message:
            'データ容量が上限 50GB に達しました。データを削除してから再度お試しください。データの読み取り・エクスポートは引き続き可能です。',
          currentBytes: error.currentBytes,
          limitBytes: error.limitBytes,
        },
      },
    };
  }
  if (error instanceof StorageGuardCircuitOpenError) {
    return {
      status: 403,
      body: {
        error: {
          code: 'STORAGE_GUARD_CIRCUIT_OPEN',
          message:
            '一時的にデータの書き込みができません。管理者に通知済みです。しばらくしてから再度お試しください。',
        },
      },
    };
  }
  return null;
}

// ================================================================
// ファイルストレージ Pre-check / Post-check (ADR-0021 §10.7)
// ================================================================

/**
 * ファイルストレージ 50GB ハードキャップ超過例外 (ADR-0021 §10.7)。
 * DB 容量とは独立した SKU のため別エラー型として定義。
 */
export class FileStorageLimitExceededError extends Error {
  readonly code = 'STORAGE_FILE_HARD_CAP_EXCEEDED';
  readonly currentBytes: number;
  readonly limitBytes: number;

  constructor(args: { tenantId: string; currentBytes: number; limitBytes: number }) {
    super(
      `Tenant ${args.tenantId} file storage usage ${args.currentBytes} bytes exceeds hard cap ${args.limitBytes} bytes`,
    );
    this.name = 'FileStorageLimitExceededError';
    this.currentBytes = args.currentBytes;
    this.limitBytes = args.limitBytes;
  }
}

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
      code: 'STORAGE_FILE_HARD_CAP_EXCEEDED' | 'BEGINNER_STORAGE_QUOTA_EXCEEDED';
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
    return { ok: true, cachedUsedBytes: 0, limitBytes: FILE_STORAGE_L3_HARD_CAP_BYTES };
  }

  const cachedUsedBytes = Number(tenant.storageFileBytesUsed);

  // ADR-0025: Beginner プラン専用 100MB 無料枠ガード (ハードキャップ判定より優先)。
  //   Pre-signed URL 発行前の判定。Beginner プランは 100MB 超過状態でアップロード拒否、
  //   overage 課金も発生させない。File 削除は許可 (assertFileStorageLimitInTx で
  //   addedBytes < 0 のときは Beginner ガード判定を skip する)。
  //   詳細: docs/adr/0025-beginner-write-guard.md / docs/specification/BEGINNER_PLAN.md
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

  if (cachedUsedBytes + estimatedNewBytes > FILE_STORAGE_L3_HARD_CAP_BYTES) {
    return {
      ok: false,
      code: 'STORAGE_FILE_HARD_CAP_EXCEEDED',
      cachedUsedBytes,
      limitBytes: FILE_STORAGE_L3_HARD_CAP_BYTES,
    };
  }
  return { ok: true, cachedUsedBytes, limitBytes: FILE_STORAGE_L3_HARD_CAP_BYTES };
}

/**
 * Post-check — transaction 内でファイルストレージ集計を atomic 更新。
 *
 *   1. SELECT FOR UPDATE で tenant 行ロック
 *   2. storageFileBytesUsed += addedBytes (delete の場合は負値で減算)
 *   3. storageFileBytesPeakThisMonth = MAX(現値, 新使用量)
 *   4. fileStorageWarningLevel を classify 結果で更新 (= 通知 spam 防止)
 *   5. ハードキャップ超過なら FileStorageLimitExceededError throw
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
 * @throws FileStorageLimitExceededError ハードキャップ超過時
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

  if (safeNewUsed > BigInt(FILE_STORAGE_L3_HARD_CAP_BYTES)) {
    throw new FileStorageLimitExceededError({
      tenantId,
      currentBytes: Number(safeNewUsed),
      limitBytes: FILE_STORAGE_L3_HARD_CAP_BYTES,
    });
  }
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
 *     const storage = mapStorageGuardErrorToResponse(e);
 *     if (storage) return NextResponse.json(storage.body, { status: storage.status });
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

export function mapFileStorageGuardErrorToResponse(error: unknown):
  | {
      status: 403;
      body: {
        error: {
          code: 'STORAGE_FILE_HARD_CAP_EXCEEDED';
          message: string;
          currentBytes: number;
          limitBytes: number;
        };
      };
    }
  | null {
  if (error instanceof FileStorageLimitExceededError) {
    return {
      status: 403,
      body: {
        error: {
          code: 'STORAGE_FILE_HARD_CAP_EXCEEDED',
          message:
            'ファイル添付の容量が上限 50GB に達しました。不要なファイルを削除してから再度お試しください。既存ファイルのダウンロードは引き続き可能です。',
          currentBytes: error.currentBytes,
          limitBytes: error.limitBytes,
        },
      },
    };
  }
  return null;
}
