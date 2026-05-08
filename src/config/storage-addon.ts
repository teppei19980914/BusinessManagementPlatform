/**
 * Storage add-on プラン定義 (Phase 2 / 2026-05-08)
 *
 * LLM プラン (beginner/expert/pro) と独立した容量プラン軸を定義する。
 * Standard は LLM プランに連動した無料枠、それ以外は月額固定の追加課金。
 *
 * テナントの実効上限 = Standard 上限 (LLM プラン連動) + add-on 拡張
 *   例: Expert + Plus → 150MB + 200MB = 350MB
 *
 * Grace period: 上限超過後 7 日間は write 維持 (= ユーザに対応猶予)。
 *   7 日経過で middleware が write を 403 で拒否 (read / export は OK)。
 *
 * 関連:
 *   - サービス: src/services/tenant-storage.service.ts
 *   - migration: prisma/migrations/20260510_storage_addon_plan
 *   - 計画: docs/roadmap/V1_FINAL_TASKS.md (Storage add-on)
 */

import type { TenantPlan } from '@/lib/tenant';

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

/** Standard 部分 (= LLM プラン連動の無料枠) のバイト数 */
export const STANDARD_STORAGE_BYTES_BY_PLAN: Record<TenantPlan, number> = {
  beginner: 50 * 1024 * 1024, //  50MB
  expert: 150 * 1024 * 1024, // 150MB
  pro: 300 * 1024 * 1024, // 300MB
};

/** add-on で追加されるバイト数 (Standard は 0 = 無料枠のみ) */
export const ADDON_EXTRA_BYTES: Record<StorageAddonPlan, number> = {
  standard: 0,
  plus: 200 * 1024 * 1024, //  +200MB
  pro_storage: 1 * 1024 * 1024 * 1024, // +1GB
  enterprise: 5 * 1024 * 1024 * 1024, // +5GB
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
  standard: 'Standard (LLM プラン連動)',
  plus: 'Storage Plus (+200MB)',
  pro_storage: 'Storage Pro (+1GB)',
  enterprise: 'Storage Enterprise (+5GB)',
};

/**
 * 上限超過後の Grace period (日数)。期限を過ぎると write 操作を middleware が 403 で拒否する。
 * P-B (Beginner expiry) の `BEGINNER_READONLY_DAYS=90` と同パターンの設計。
 */
export const STORAGE_GRACE_PERIOD_DAYS = 7;

/**
 * テナントの実効ストレージ上限を計算する。
 *
 * @param llmPlan  LLM プラン (= Tenant.plan)
 * @param addonPlan Storage add-on プラン (= Tenant.storageAddonPlan)
 * @returns バイト単位の上限値
 */
export function computeStorageLimitBytes(
  llmPlan: TenantPlan,
  addonPlan: StorageAddonPlan,
): number {
  return STANDARD_STORAGE_BYTES_BY_PLAN[llmPlan] + ADDON_EXTRA_BYTES[addonPlan];
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
