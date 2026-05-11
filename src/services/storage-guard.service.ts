/**
 * ストレージ容量 enforcement サービス (PR-3 / 2026-05-15)
 *
 * 役割:
 *   テナント配下のデータを作成 / 更新 / インポートする際、
 *   `Tenant.storageAddonPlan` に応じた上限 (Standard 20MB / Plus 220MB /
 *   Pro 1.02GB / Enterprise 5.02GB) を超えないことをリアルタイムで保証する。
 *
 * 二段階チェック戦略:
 *
 *   **Pre-check** (リクエスト入口、低コスト):
 *     - `Tenant.storageBytesUsed` (キャッシュ値) + ペイロード byte size の近似で予測
 *     - 明らかに超過なら 413 で即時拒否、無駄な DB 書込を避ける
 *     - cache lag (最大 24h) があるため fail-open 寄り (近似で通すケースあり)
 *
 *   **Post-check** (transaction 内、正確):
 *     - INSERT/UPDATE 後に `calculateTenantStorageBytes(tenantId)` で実測
 *     - 超過なら `throw new StorageLimitExceededError()` で transaction 全件ロールバック
 *     - 呼出側 API は 403 `STORAGE_LIMIT_EXCEEDED` で応答
 *
 * 使い方:
 *
 * ```ts
 * import { assertStorageLimitInTx, withStorageGuard } from '@/services/storage-guard.service';
 *
 * // 単発の create/update
 * await withStorageGuard(tenantId, async (tx) => {
 *   await tx.project.create({ data: { ... } });
 * });
 *
 * // 既存の transaction の中で
 * await prisma.$transaction(async (tx) => {
 *   await tx.project.create({ data: { ... } });
 *   await assertStorageLimitInTx(tx, tenantId);
 * });
 * ```
 *
 * 設計判断:
 *   - Pre-check は **入口バリデーション** (= ペイロード明らかに巨大なら早期拒否)。
 *     キャッシュ値での予測なので 24h ラグでズレうるが、Post-check が最終境界。
 *   - Post-check は **transaction 内の最終境界**。pg_column_size を再計算するため正確だが
 *     重い (テナント当たり 100ms 〜 数百 ms)。
 *   - 両方使う想定だが、コスト過大なら個別 endpoint で Post-check のみでも可。
 *
 * 関連:
 *   - 上限定義: src/config/storage-addon.ts (computeStorageLimitBytes)
 *   - 使用量計算: src/services/tenant-storage.service.ts (calculateTenantStorageBytes)
 *   - middleware (7 日 Grace 後の全 write 停止): src/lib/auth.config.ts
 */

import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';
import {
  computeStorageLimitBytes,
  isStorageAddonPlan,
  type StorageAddonPlan,
} from '@/config/storage-addon';
// PR-3: tenant-storage.service の calculateTenantStorageBytes (=prisma 直叩き) は
//   transaction 外を見てしまうので使えない。代わりに本ファイル内で tx スコープの
//   $queryRaw 版 (calculateTenantStorageBytesInTx) を持つ。

/**
 * ストレージ上限超過時に投げる例外。
 * transaction 内で throw すれば全件ロールバックされる。
 * 呼出側 API は本例外を catch して 403 STORAGE_LIMIT_EXCEEDED で応答する。
 */
export class StorageLimitExceededError extends Error {
  readonly code = 'STORAGE_LIMIT_EXCEEDED';
  readonly currentBytes: number;
  readonly limitBytes: number;
  readonly addonPlan: StorageAddonPlan;

  constructor(args: {
    tenantId: string;
    currentBytes: number;
    limitBytes: number;
    addonPlan: StorageAddonPlan;
  }) {
    super(
      `Tenant ${args.tenantId} storage usage ${args.currentBytes} bytes exceeds limit ${args.limitBytes} bytes (plan=${args.addonPlan})`,
    );
    this.name = 'StorageLimitExceededError';
    this.currentBytes = args.currentBytes;
    this.limitBytes = args.limitBytes;
    this.addonPlan = args.addonPlan;
  }
}

/** Prisma transaction client (PrismaClient の transaction 内コールバック引数) */
export type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * 共通: テナントの addonPlan + 上限を取得する。
 */
async function getTenantLimit(
  tx: TxClient | PrismaClient,
  tenantId: string,
): Promise<{ addonPlan: StorageAddonPlan; limitBytes: number; cachedUsedBytes: number }> {
  const tenant = await tx.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: { storageAddonPlan: true, storageBytesUsed: true },
  });
  if (!tenant) {
    // テナント不在 → 上位で 401/404 が出ているはずだが defensive に明示
    throw new Error(`Tenant not found: ${tenantId}`);
  }
  const addonPlan: StorageAddonPlan = isStorageAddonPlan(tenant.storageAddonPlan)
    ? tenant.storageAddonPlan
    : 'standard';
  return {
    addonPlan,
    limitBytes: computeStorageLimitBytes(addonPlan),
    cachedUsedBytes: Number(tenant.storageBytesUsed),
  };
}

/**
 * **Pre-check** — リクエスト入口で「明らかに超過するか」を低コストに判定する。
 *
 * - キャッシュ値 (storageBytesUsed) + 予測サイズで判定
 * - キャッシュは日次 cron 更新なので最大 24h ラグ。fail-open 寄り (= 通すケースあり)
 * - 真の境界は Post-check が担保する
 *
 * @param tenantId 対象テナント
 * @param estimatedNewBytes 追加見込みバイト数 (= payload サイズ等の予測値)
 * @returns ok=true なら継続、false なら即時拒否
 */
export async function precheckStorageLimit(
  tenantId: string,
  estimatedNewBytes: number,
): Promise<
  | { ok: true; cachedUsedBytes: number; limitBytes: number }
  | {
      ok: false;
      code: 'STORAGE_LIMIT_EXCEEDED';
      cachedUsedBytes: number;
      limitBytes: number;
      addonPlan: StorageAddonPlan;
    }
> {
  const { addonPlan, limitBytes, cachedUsedBytes } = await getTenantLimit(prisma, tenantId);
  if (cachedUsedBytes + estimatedNewBytes > limitBytes) {
    return {
      ok: false,
      code: 'STORAGE_LIMIT_EXCEEDED',
      cachedUsedBytes,
      limitBytes,
      addonPlan,
    };
  }
  return { ok: true, cachedUsedBytes, limitBytes };
}

/**
 * **Post-check** — transaction 内で実測値を計算し、超過なら throw でロールバック。
 *
 * `prisma.$transaction(async (tx) => { ... await assertStorageLimitInTx(tx, tenantId); })`
 * のように **書込の直後** に呼ぶこと。super-admin 系の cron も含めると複数の経路から
 * 呼ばれうるため、tx 引数を必須化して「正しい tx の中で動いている」ことを型で保証する。
 *
 * 副作用: 計算で取得した最新値を `Tenant.storageBytesUsed` キャッシュに同期して書き戻す
 *   (= 後続リクエストの pre-check 精度が向上)。
 *
 * @param tx prisma transaction client
 * @param tenantId 対象テナント
 * @throws StorageLimitExceededError 超過時
 */
export async function assertStorageLimitInTx(
  tx: TxClient,
  tenantId: string,
): Promise<void> {
  const { addonPlan, limitBytes } = await getTenantLimit(tx, tenantId);

  // 実測 (pg_column_size を全 15 テーブル横断で集計)
  const usedBytes = Number(await calculateTenantStorageBytesInTx(tx, tenantId));

  // キャッシュ同期 (transaction 内で書き戻す。ロールバック時は当然破棄される)
  await tx.tenant.update({
    where: { id: tenantId },
    data: { storageBytesUsed: BigInt(usedBytes), storageBytesUsedAt: new Date() },
  });

  if (usedBytes > limitBytes) {
    throw new StorageLimitExceededError({
      tenantId,
      currentBytes: usedBytes,
      limitBytes,
      addonPlan,
    });
  }
}

/**
 * **wrapper**: $transaction + Post-check を一括で行うヘルパ。
 *
 * - fn の中で `tx.X.create / update / delete` を呼ぶ
 * - fn 終了後に自動で assertStorageLimitInTx を実行
 * - 超過時は transaction ロールバック + StorageLimitExceededError throw
 *
 * 既存の transaction を使っていない単発 create/update の最小変更パターン:
 *
 * ```ts
 * // 修正前
 * await prisma.project.create({ data: {...} });
 *
 * // 修正後 (PR-3)
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

/**
 * transaction 内で `calculateTenantStorageBytes` 相当の集計を実行する。
 *
 * `tenant-storage.service.ts` 側の `calculateTenantStorageBytes` は `prisma.$queryRaw` を
 * 直接使うため transaction 外を見てしまう。本関数は tx スコープで同 SQL を実行する。
 */
async function calculateTenantStorageBytesInTx(
  tx: TxClient,
  tenantId: string,
): Promise<bigint> {
  type Row = { total_bytes: bigint };
  // prisma の TxClient でも $queryRaw は利用可。SQL injection 防止のため値は parametrized。
  const rows = await (tx as unknown as { $queryRaw: typeof prisma.$queryRaw }).$queryRaw<Row[]>`
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
  return rows[0]?.total_bytes ?? BigInt(0);
}

/**
 * API route 側のエラーハンドリングを簡潔にするためのヘルパ。
 *
 * 例:
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
 */
export function mapStorageGuardErrorToResponse(error: unknown):
  | {
      status: 403;
      body: {
        error: {
          code: 'STORAGE_LIMIT_EXCEEDED';
          message: string;
          currentBytes: number;
          limitBytes: number;
          addonPlan: StorageAddonPlan;
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
            'ストレージ上限を超えるためデータを保存できません。データを削除するか、Storage プランをアップグレードしてください。',
          currentBytes: error.currentBytes,
          limitBytes: error.limitBytes,
          addonPlan: error.addonPlan,
        },
      },
    };
  }
  return null;
}

// テスト用に export (Prisma type に依存しない方式で transaction 外計算が必要な場合のため)
export const _internals = {
  calculateTenantStorageBytesInTx,
};

// Re-export for convenience
export type { Prisma };
