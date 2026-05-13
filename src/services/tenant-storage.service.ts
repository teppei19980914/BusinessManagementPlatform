/**
 * テナントストレージ管理サービス (Phase 2 / 2026-05-08)
 *
 * 役割:
 *   テナントの DB ストレージ使用量を集計し、Storage add-on プランの上限管理 + 課金 + Grace period
 *   制御を担う。
 *
 * 提供機能:
 *   - calculateTenantStorageBytes: テナント単位で `pg_column_size` を集計して実使用量を返す
 *   - getStorageInfo: 現在の使用量・上限・プラン情報をまとめて取得
 *   - updateStorageAddonPlan: アップグレード即時 / ダウングレード翌月予約
 *   - cancelScheduledStorageAddon: ダウングレード予約キャンセル
 *   - updateAllStorageBytesUsed: 全テナントの使用量を更新 (日次 cron)
 *   - checkAndStartGracePeriod: 超過検知 → Grace period 開始 (日次 cron)
 *   - applyScheduledStorageChanges: 予約済みダウングレードを適用 (月初 cron)
 *   - getStorageGraceState: Grace 状態 (active / grace_active / write_blocked) を返す
 *
 * 認可境界:
 *   呼出側で「テナント管理者 (admin) が自テナント」or「super_admin が任意テナント」を確認した前提。
 *
 * 使用量計算の戦略:
 *   - 日次 cron で `pg_column_size` 集計し `Tenant.storageBytesUsed` に保存 (キャッシュ)
 *   - UI 表示はキャッシュ値を使用 (= 24 時間のラグを許容)
 *   - 厳密に最新が必要な箇所 (= 上限超過判定 + プラン変更時) は on-demand で再計算
 *   - リアルタイム更新 (= CRUD 毎の更新) は重いので採用しない
 *
 * 関連:
 *   - 計画: docs/roadmap/V1_FINAL_TASKS.md (Storage add-on)
 *   - config: src/config/storage-addon.ts
 *   - middleware: Grace 7 日超過テナントの write を拒否
 */

import { prisma } from '@/lib/db';
import {
  ADDON_MONTHLY_JPY,
  STORAGE_GRACE_PERIOD_DAYS,
  computeStorageLimitBytes,
  isStorageAddonPlan,
  isStorageUpgrade,
  type StorageAddonPlan,
} from '@/config/storage-addon';
import { isTenantPlan, type TenantPlan } from '@/lib/tenant';
import { recordError } from '@/services/error-log.service';
// PR-4 (2026-05-15): テナント TZ で翌月適用日を計算
import { getTenantNextMonthStart } from '@/lib/tenant-time';

// PR-3 (2026-05-15): computeStorageLimitBytes は LLM プラン非依存になったため、
//   呼出側で llmPlan を解決する必要はなくなった。
//   llmPlan は TenantStorageInfo の表示用情報としてのみ残置。

// ================================================================
// 公開型
// ================================================================

export type StorageGraceState =
  | 'active' // 上限内、正常
  | 'grace_active' // 上限超過、Grace period 中 (write 可、警告表示)
  | 'write_blocked'; // Grace 7 日経過、write 停止 (read / export は OK)

export type TenantStorageInfo = {
  tenantId: string;
  llmPlan: TenantPlan;
  storageAddonPlan: StorageAddonPlan;
  /** 当月の add-on 月額 (Standard なら 0) */
  storageAddonMonthlyJpy: number;
  /** 現使用量 (バイト、キャッシュ値) */
  storageBytesUsed: number;
  /** 上限 (バイト、Standard 部分 + add-on 拡張の合計) */
  storageLimitBytes: number;
  /** 使用率 (0.0 - 1.0、上限超過時は > 1.0) */
  usageRatio: number;
  /** Grace state */
  graceState: StorageGraceState;
  /** Grace period 開始日時 (Grace 中のみ) */
  graceStartedAt: Date | null;
  /** Write 停止までの残り日数 (Grace 中のみ、0 以下なら既に停止) */
  graceDaysRemaining: number | null;
  /** 予約されたダウングレード適用日時 (なければ null) */
  scheduledStorageAddonAt: Date | null;
  scheduledNextStorageAddon: StorageAddonPlan | null;
  /** キャッシュの最終更新時刻 */
  storageBytesUsedAt: Date | null;
};

export type UpdateStorageAddonResult =
  | { ok: true; appliedImmediately: boolean; scheduledFor: Date | null }
  | {
      ok: false;
      error:
        | 'TENANT_NOT_FOUND'
        | 'INVALID_PLAN'
        | 'DOWNGRADE_BLOCKED_BY_USAGE'; // 現使用量 > 新上限
      message: string;
    };

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

// ================================================================
// 公開関数: 状態取得
// ================================================================

/**
 * テナントのストレージ情報を取得する (テナント設定画面・super_admin ダッシュボード用)。
 *
 * @param tenantId 対象テナント ID
 * @returns 使用量・上限・課金・Grace 状態をまとめた情報。テナント不在なら null
 */
export async function getStorageInfo(tenantId: string): Promise<TenantStorageInfo | null> {
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      id: true,
      plan: true,
      storageAddonPlan: true,
      storageBytesUsed: true,
      storageBytesUsedAt: true,
      storageGracePeriodStartedAt: true,
      scheduledStorageAddonAt: true,
      scheduledNextStorageAddon: true,
    },
  });
  if (!tenant) return null;

  return computeStorageInfo(tenant);
}

/**
 * Tenant の row データから `TenantStorageInfo` を計算する内部 helper。
 *
 * 不正な enum 値 (= migration 前 / DB 改ざん) は Standard / beginner 扱いに縮退して返す。
 */
function computeStorageInfo(tenant: {
  id: string;
  plan: string;
  storageAddonPlan: string;
  storageBytesUsed: bigint;
  storageBytesUsedAt: Date | null;
  storageGracePeriodStartedAt: Date | null;
  scheduledStorageAddonAt: Date | null;
  scheduledNextStorageAddon: string | null;
}): TenantStorageInfo {
  const llmPlan: TenantPlan = isTenantPlan(tenant.plan) ? tenant.plan : 'beginner';
  const addonPlan: StorageAddonPlan = isStorageAddonPlan(tenant.storageAddonPlan)
    ? tenant.storageAddonPlan
    : 'standard';

  // PR-3 (2026-05-15): 20MB + add-on 拡張で上限を算出 (LLM プラン非依存)
  const limitBytes = computeStorageLimitBytes(addonPlan);
  const usedBytes = Number(tenant.storageBytesUsed);
  const usageRatio = limitBytes > 0 ? usedBytes / limitBytes : 0;

  // Grace state 判定
  let graceState: StorageGraceState = 'active';
  let graceDaysRemaining: number | null = null;
  if (tenant.storageGracePeriodStartedAt) {
    const elapsedMs = Date.now() - tenant.storageGracePeriodStartedAt.getTime();
    const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
    graceDaysRemaining = Math.max(0, Math.ceil(STORAGE_GRACE_PERIOD_DAYS - elapsedDays));
    graceState = elapsedDays >= STORAGE_GRACE_PERIOD_DAYS ? 'write_blocked' : 'grace_active';
  }

  const scheduledNextStorageAddon =
    tenant.scheduledNextStorageAddon && isStorageAddonPlan(tenant.scheduledNextStorageAddon)
      ? tenant.scheduledNextStorageAddon
      : null;

  return {
    tenantId: tenant.id,
    llmPlan,
    storageAddonPlan: addonPlan,
    storageAddonMonthlyJpy: ADDON_MONTHLY_JPY[addonPlan],
    storageBytesUsed: usedBytes,
    storageLimitBytes: limitBytes,
    usageRatio,
    graceState,
    graceStartedAt: tenant.storageGracePeriodStartedAt,
    graceDaysRemaining,
    scheduledStorageAddonAt: tenant.scheduledStorageAddonAt,
    scheduledNextStorageAddon,
    storageBytesUsedAt: tenant.storageBytesUsedAt,
  };
}

/**
 * Grace 状態 = `write_blocked` のテナントを判定する pure 関数 (middleware 用)。
 * middleware は DB クエリを最小化したいため、JWT claim or 軽量 SELECT で取得した
 * 最小限のフィールドだけで判定する。
 */
export function isStorageWriteBlocked(input: {
  storageGracePeriodStartedAt: Date | null;
  now?: Date;
}): boolean {
  if (!input.storageGracePeriodStartedAt) return false;
  const now = input.now ?? new Date();
  const elapsedMs = now.getTime() - input.storageGracePeriodStartedAt.getTime();
  const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
  return elapsedDays >= STORAGE_GRACE_PERIOD_DAYS;
}

// ================================================================
// 公開関数: プラン変更
// ================================================================

/**
 * Storage add-on プランを変更する。
 *
 * 動作:
 *   - アップグレード (例: standard → plus): **即時反映** + 当月から add-on 月額発生
 *   - ダウングレード (例: plus → standard): **翌月 1 日 UTC に予約**
 *     ただし「現使用量 > ダウングレード後の上限」なら拒否 (DOWNGRADE_BLOCKED_BY_USAGE)
 *   - 同一プラン: noop で ok
 *
 * @param tenantId 対象テナント
 * @param nextPlan 変更先プラン
 */
export async function updateStorageAddonPlan(
  tenantId: string,
  nextPlan: StorageAddonPlan,
): Promise<UpdateStorageAddonResult> {
  if (!isStorageAddonPlan(nextPlan)) {
    return { ok: false, error: 'INVALID_PLAN', message: '不正なプラン値です' };
  }

  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      id: true,
      plan: true,
      storageAddonPlan: true,
      storageBytesUsed: true,
      // PR-4 (2026-05-15): 翌月適用日をテナント TZ ベースで計算するため取得
      timezone: true,
    },
  });
  if (!tenant) {
    return { ok: false, error: 'TENANT_NOT_FOUND', message: 'テナントが見つかりません' };
  }

  const currentAddon: StorageAddonPlan = isStorageAddonPlan(tenant.storageAddonPlan)
    ? tenant.storageAddonPlan
    : 'standard';

  // 同一プラン: noop
  if (currentAddon === nextPlan) {
    return { ok: true, appliedImmediately: true, scheduledFor: null };
  }

  if (isStorageUpgrade(currentAddon, nextPlan)) {
    // アップグレード: 即時反映 + 予約クリア
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        storageAddonPlan: nextPlan,
        scheduledStorageAddonAt: null,
        scheduledNextStorageAddon: null,
      },
    });
    return { ok: true, appliedImmediately: true, scheduledFor: null };
  }

  // ダウングレード: 現使用量チェック (使用量 > ダウングレード後上限なら拒否)
  // PR-3 (2026-05-15): 20MB + add-on 拡張 (LLM プラン非依存)
  const newLimitBytes = computeStorageLimitBytes(nextPlan);
  if (Number(tenant.storageBytesUsed) > newLimitBytes) {
    return {
      ok: false,
      error: 'DOWNGRADE_BLOCKED_BY_USAGE',
      message: `現在の使用量 (${formatBytes(Number(tenant.storageBytesUsed))}) がダウングレード後の上限 (${formatBytes(newLimitBytes)}) を超えています。先にデータを削除してから再度予約してください。`,
    };
  }

  // PR-4 (2026-05-15): 翌月 1 日 (テナント TZ 0:00) に予約。
  const now = new Date();
  const nextMonthStart = getTenantNextMonthStart(now, tenant.timezone);
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      scheduledStorageAddonAt: nextMonthStart,
      scheduledNextStorageAddon: nextPlan,
    },
  });
  return { ok: true, appliedImmediately: false, scheduledFor: nextMonthStart };
}

/**
 * ダウングレード予約をキャンセルする。
 */
export async function cancelScheduledStorageAddon(tenantId: string): Promise<void> {
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      scheduledStorageAddonAt: null,
      scheduledNextStorageAddon: null,
    },
  });
}

// ================================================================
// 公開関数: cron 用バッチ処理
// ================================================================

/**
 * 単一テナントの `storageBytesUsed` キャッシュを更新する。
 *
 * super_admin / テナント管理者の画面遷移時に on-demand で呼ばれる
 * (= キャッシュの 24 時間ラグを排除する 2026-05-14 仕様)。
 *
 * 失敗時は呼出側に throw する (画面側でハンドリング)。複数テナントを連続実行する
 * 場合は `updateAllStorageBytesUsed` を使い、個別失敗は内部で吸収される。
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
 * 全テナントの `storageBytesUsed` キャッシュを更新する (日次 cron + super_admin
 * ダッシュボード遷移時の on-demand 用)。
 *
 * 動作: 削除済テナントは除外し、各テナントで `calculateTenantStorageBytes` を実行 →
 *   Tenant 行に書き戻す。失敗は recordError でログ取り、ループは継続。
 *
 * recordError 自体の失敗 (= error_logs テーブル不在等) は console.error
 * にフォールバックして無視する (2026-05-14: 本番で error_logs 未 migrate
 * の状況でも本処理を継続させる防御)。
 *
 * @returns 更新したテナント件数
 */
export async function updateAllStorageBytesUsed(): Promise<number> {
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });

  let updated = 0;
  for (const t of tenants) {
    try {
      const bytes = await calculateTenantStorageBytes(t.id);
      await prisma.tenant.update({
        where: { id: t.id },
        data: {
          storageBytesUsed: bytes,
          storageBytesUsedAt: new Date(),
        },
      });
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
 * 全テナントの上限超過状態を判定し、Grace period の開始/解除を行う (日次 cron 用)。
 *
 * 動作:
 *   - 使用量 > 上限 かつ Grace 未開始 → `storageGracePeriodStartedAt = NOW()`
 *   - 使用量 ≤ 上限 かつ Grace 開始済 → `storageGracePeriodStartedAt = NULL` でクリア
 *
 * @returns { graceStartedCount, graceClearedCount }
 */
export async function checkAndStartGracePeriod(): Promise<{
  graceStartedCount: number;
  graceClearedCount: number;
}> {
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      storageAddonPlan: true,
      storageBytesUsed: true,
      storageGracePeriodStartedAt: true,
    },
  });

  let started = 0;
  let cleared = 0;

  for (const t of tenants) {
    const addonPlan: StorageAddonPlan = isStorageAddonPlan(t.storageAddonPlan)
      ? t.storageAddonPlan
      : 'standard';
    // PR-3 (2026-05-15): 20MB + add-on 拡張 (LLM プラン非依存)
    const limit = computeStorageLimitBytes(addonPlan);
    const used = Number(t.storageBytesUsed);
    const isOverLimit = used > limit;

    if (isOverLimit && !t.storageGracePeriodStartedAt) {
      // 超過開始: Grace タイマー開始
      await prisma.tenant.update({
        where: { id: t.id },
        data: { storageGracePeriodStartedAt: new Date() },
      });
      started += 1;
    } else if (!isOverLimit && t.storageGracePeriodStartedAt) {
      // 超過解消: Grace + 通知履歴をクリア
      await prisma.tenant.update({
        where: { id: t.id },
        data: {
          storageGracePeriodStartedAt: null,
          storageOverLimitNoticeSentAt: null,
        },
      });
      cleared += 1;
    }
  }

  return { graceStartedCount: started, graceClearedCount: cleared };
}

/**
 * 月初 cron で予約済みダウングレードを適用する (P-X4 plan 変更 cron と同パターン)。
 *
 * 動作:
 *   - `scheduledStorageAddonAt <= NOW()` のテナントを対象
 *   - 念のため再度「現使用量 > 新上限」をチェック (= 月跨ぎでデータ追加された可能性に備える)
 *     超過していたら適用 skip + ログ記録 (ユーザはダウングレードできず Plus のまま課金継続)
 *
 * @returns { applied, skippedDueToUsage }
 */
export async function applyScheduledStorageChanges(now: Date = new Date()): Promise<{
  applied: number;
  skippedDueToUsage: number;
}> {
  const candidates = await prisma.tenant.findMany({
    where: {
      deletedAt: null,
      scheduledStorageAddonAt: { lte: now },
      scheduledNextStorageAddon: { not: null },
    },
    select: {
      id: true,
      storageAddonPlan: true,
      storageBytesUsed: true,
      scheduledNextStorageAddon: true,
    },
  });

  let applied = 0;
  let skipped = 0;

  for (const t of candidates) {
    const nextPlan = t.scheduledNextStorageAddon;
    if (!nextPlan || !isStorageAddonPlan(nextPlan)) {
      // 不整合データは skip
      await recordError({
        severity: 'error',
        source: 'cron',
        message: `Invalid scheduledNextStorageAddon: ${String(nextPlan)} (tenant=${t.id})`,
        context: { kind: 'storage_addon_apply', tenantId: t.id, nextPlan },
      });
      continue;
    }

    // PR-3 (2026-05-15): 20MB + add-on 拡張 (LLM プラン非依存)
    const newLimit = computeStorageLimitBytes(nextPlan);
    if (Number(t.storageBytesUsed) > newLimit) {
      // 月跨ぎでデータ増加: 適用 skip + 予約クリア (= ユーザは現プラン継続)
      // 当月以降も超過状態が継続するため checkAndStartGracePeriod が Grace を開始する。
      await prisma.tenant.update({
        where: { id: t.id },
        data: {
          scheduledStorageAddonAt: null,
          scheduledNextStorageAddon: null,
        },
      });
      await recordError({
        severity: 'warn',
        source: 'cron',
        message: `Scheduled storage downgrade skipped: usage > new limit`,
        context: {
          kind: 'storage_addon_apply',
          tenantId: t.id,
          currentPlan: t.storageAddonPlan,
          nextPlan,
          usedBytes: Number(t.storageBytesUsed),
          newLimitBytes: newLimit,
        },
      });
      skipped += 1;
      continue;
    }

    await prisma.tenant.update({
      where: { id: t.id },
      data: {
        storageAddonPlan: nextPlan,
        scheduledStorageAddonAt: null,
        scheduledNextStorageAddon: null,
      },
    });
    applied += 1;
  }

  return { applied, skippedDueToUsage: skipped };
}

// ================================================================
// 内部: ヘルパ
// ================================================================

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}
