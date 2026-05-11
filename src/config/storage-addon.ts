/**
 * Storage add-on プラン定義 (Phase 2 / 2026-05-08, PR-3 / 2026-05-15 改修)
 *
 * 設計判断 (PR-3 / 2026-05-15):
 *   - **LLM プラン連動の Standard 上限を廃止し、全プラン共通 20MB ベース** に統一。
 *     旧仕様では Beginner 50MB / Expert 150MB / Pro 300MB と LLM プランに連動していたが、
 *     ユーザ要件で「Standard 20MB / Storage Plus 220MB / Storage Pro 1.02GB / Storage Enterprise 5.02GB」
 *     の dynamic 制御に確定。
 *   - **テナントの実効上限 = 20MB + add-on 拡張**:
 *     - standard:   20MB                  (default、追加課金なし)
 *     - plus:       20MB + 200MB = 220MB  (+¥500/月)
 *     - pro_storage: 20MB + 1000MB = 1.02GB (+¥1500/月)
 *     - enterprise: 20MB + 5000MB = 5.02GB (+¥5000/月)
 *
 * Grace period: 上限超過後 7 日間は write 維持 (= ユーザに対応猶予)。
 *   7 日経過で middleware が write を 403 で拒否 (read / export は OK)。
 *
 * 関連:
 *   - サービス: src/services/tenant-storage.service.ts
 *   - guard:    src/services/storage-guard.service.ts (PR-3 で追加。create/update/import の上限チェック)
 *   - migration: prisma/migrations/20260510_storage_addon_plan (storage_addon_plan 列追加)
 *   - 計画: docs/roadmap/V1_FINAL_TASKS.md (Storage add-on)
 */

/** Storage add-on プラン名 (DB の storage_addon_plan カラムと対応) */
export type StorageAddonPlan = 'standard' | 'plus' | 'pro_storage' | 'enterprise';

export const STORAGE_ADDON_PLANS: readonly StorageAddonPlan[] = [
  'standard',
  'plus',
  'pro_storage',
  'enterprise',
] as const;

/** type guard */
export function isStorageAddonPlan(value: unknown): value is StorageAddonPlan {
  return typeof value === 'string' && (STORAGE_ADDON_PLANS as readonly string[]).includes(value);
}

/**
 * PR-3 (2026-05-15): 全テナント共通の Standard 部分 (20MB)。
 *
 * LLM プラン連動を廃止 (旧 STANDARD_STORAGE_BYTES_BY_PLAN は撤去)。
 */
export const STANDARD_STORAGE_BYTES = 20 * 1024 * 1024; // 20MB

/** add-on で追加されるバイト数 (Standard は 0 = 無料枠のみ) */
export const ADDON_EXTRA_BYTES: Record<StorageAddonPlan, number> = {
  standard: 0,
  plus: 200 * 1024 * 1024, //  +200MB → 合計 220MB
  pro_storage: 1000 * 1024 * 1024, // +1000MB → 合計 1.02GB
  enterprise: 5000 * 1024 * 1024, // +5000MB → 合計 5.02GB
};

/** add-on の月額 (円、Standard は 0 = 無料) */
export const ADDON_MONTHLY_JPY: Record<StorageAddonPlan, number> = {
  standard: 0,
  plus: 500,
  pro_storage: 1500,
  enterprise: 5000,
};

/** UI 表示用ラベル */
export const ADDON_PLAN_LABELS: Record<StorageAddonPlan, string> = {
  standard: 'Standard (20MB)',
  plus: 'Storage Plus (220MB)',
  pro_storage: 'Storage Pro (1.02GB)',
  enterprise: 'Storage Enterprise (5.02GB)',
};

/**
 * 上限超過後の Grace period (日数)。期限を過ぎると write 操作を middleware が 403 で拒否する。
 * P-B (Beginner expiry) の `BEGINNER_READONLY_DAYS=90` と同パターンの設計。
 */
export const STORAGE_GRACE_PERIOD_DAYS = 7;

/**
 * テナントの実効ストレージ上限を計算する (PR-3 / 2026-05-15: llmPlan 引数を撤去)。
 *
 * @param addonPlan Storage add-on プラン (= Tenant.storageAddonPlan)
 * @returns バイト単位の上限値
 */
export function computeStorageLimitBytes(addonPlan: StorageAddonPlan): number {
  return STANDARD_STORAGE_BYTES + ADDON_EXTRA_BYTES[addonPlan];
}

/**
 * Storage プラン階層の順序定義 (アップグレード/ダウングレード判定用)。
 * 数値が大きいほど上位プラン。
 */
export const STORAGE_ADDON_ORDER: Record<StorageAddonPlan, number> = {
  standard: 0,
  plus: 1,
  pro_storage: 2,
  enterprise: 3,
};

export function isStorageUpgrade(
  current: StorageAddonPlan,
  next: StorageAddonPlan,
): boolean {
  return STORAGE_ADDON_ORDER[next] > STORAGE_ADDON_ORDER[current];
}
