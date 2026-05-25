/**
 * DB 容量従量課金 — 単価・閾値・計算ヘルパ (ADR-0020 / 2026-05-25)
 *
 * 役割:
 *   月中 peak (max bytes) ベースで「テナント DB 使用量」を従量課金するための単価定数・
 *   閾値定義・計算ヘルパを単一の真実源として提供する。
 *
 * 課金モデル (ADR-0020):
 *   - 無料枠: 50MB / tenant
 *   - 超過分: 1GB 単位で ¥50 (階段関数型、1MB 未満は繰上)
 *   - 単位は SI (1GB = 10^9 bytes, 1MB = 10^6 bytes) — LP 表記・Supabase 料金体系と整合
 *   - 計測時点: 月中 peak (月末削除→月初再投入の抜け道防止 / Supabase GB-Hours と乖離最小)
 *
 * 4 層防御 (R3 「他テナント影響は絶対不許容」原則の技術実装):
 *   - L1 1GB: ユーザ通知 (テナント設定画面に表示)
 *   - L2 10GB: super_admin 通知 (recordError + ダッシュボード)
 *   - L3 50GB: write 拒否 (ハードキャップ、StorageLimitExceededError 流用)
 *   - L4 instance-wide: Compute 推奨容量の 80% で super_admin alert
 *
 * 関連:
 *   - ADR: docs/adr/0020-db-capacity-usage-based-billing.md
 *   - 計測: src/services/storage-guard.service.ts (write 時 peak update + hard cap)
 *   - 月初集計: src/services/tenant-monthly-reset.service.ts
 *   - Stripe: src/services/stripe-usage-flush.service.ts (callType='db_capacity_overage')
 *   - Memory: feedback_billing_invariant.md (ApiCallLog SUM = 表示 = 請求 invariant)
 */

// ============================================================
// 単位定数 (SI: International System)
// ============================================================

/** 1MB = 10^6 bytes (SI 単位、Supabase 料金体系と整合) */
export const SI_MB_BYTES = 1_000_000;

/** 1GB = 10^9 bytes (SI 単位) = 1000MB */
export const SI_GB_BYTES = 1_000_000_000;

// ============================================================
// 課金パラメータ (ADR-0020 §2.1)
// ============================================================

/** 無料枠 (バイト) = 50MB (SI) = 50,000,000 bytes */
export const DB_CAPACITY_FREE_TIER_BYTES = 50 * SI_MB_BYTES;

/** 課金単価: 1 GB tier あたり ¥50 (階段関数) */
export const DB_CAPACITY_PRICE_JPY_PER_GB_TIER = 50;

// ============================================================
// 4 層防御閾値 (ADR-0020 §2.4)
// ============================================================

/** L1: ユーザ通知 (1GB SI = 1,000,000,000 bytes) */
export const DB_CAPACITY_L1_USER_WARNING_BYTES = 1 * SI_GB_BYTES;

/** L2: super_admin 通知 (10GB SI = 10,000,000,000 bytes) */
export const DB_CAPACITY_L2_ADMIN_ALERT_BYTES = 10 * SI_GB_BYTES;

/**
 * L3: ハードキャップ (50GB SI = 50,000,000,000 bytes)
 *
 * write 拒否される技術上限。Supabase Micro Compute (1GB RAM) の
 * マルチテナント運用で「他テナントの cache hit ratio を破壊する閾値」(Neon 公式知見)。
 * コスト抑制目的ではなく、他テナント保護の技術的安全弁。
 */
export const DB_CAPACITY_L3_HARD_CAP_BYTES = 50 * SI_GB_BYTES;

/**
 * L4: instance-wide alert 閾値 (Compute サイズ別、SI bytes)。
 *
 * PostgreSQL の shared_buffers = 25% RAM 原則 + 余裕係数より推定。
 * launch 後 3 ヶ月の実データで再評価。env DB_INSTANCE_ALERT_THRESHOLD_BYTES で上書き可。
 */
export const DB_INSTANCE_ALERT_THRESHOLDS_BY_COMPUTE: Record<string, number> = {
  micro: 4 * SI_GB_BYTES, // Pro 標準。Micro 1GB RAM の推奨 DB 5GB の 80%
  small: 8 * SI_GB_BYTES, // Small 2GB RAM の推奨 DB 10GB の 80%
  medium: 20 * SI_GB_BYTES, // Medium 4GB RAM の推奨 DB 25GB の 80%
  large: 80 * SI_GB_BYTES, // Large 8GB RAM の推奨 DB 100GB の 80%
};

// ============================================================
// drift 検知閾値 (ADR-0020 §3.5)
// ============================================================

/**
 * tenant peak SUM と pg_database_size の乖離率 warning 閾値。
 * 100% (= 2 倍) 以下なら正常範囲 (PostgreSQL の WAL / index / catalog overhead は通常 1.2-1.5 倍)。
 */
export const DB_DRIFT_WARNING_RATIO = 0.5;

/** drift critical 閾値 (= 100% 乖離 = pg_database_size が tenant SUM の 2 倍超) */
export const DB_DRIFT_CRITICAL_RATIO = 1.0;

// ============================================================
// circuit breaker 設定 (R3: fail-close)
// ============================================================

/**
 * storage-guard の計測失敗が連続して発生した場合に circuit breaker を open する閾値。
 * open 状態では write を拒否し、super_admin に緊急アラートを送る。
 */
export const STORAGE_GUARD_CIRCUIT_BREAKER_THRESHOLD = 3;

// ============================================================
// 計算ヘルパ
// ============================================================

/**
 * 課金対象バイト数を計算する (= 無料枠 50MB を差し引いた超過分)。
 *
 * @param peakBytes 月中 peak (= max bytes during month)
 * @returns 超過バイト数 (無料枠内なら 0n)
 */
export function calculateBillableBytes(peakBytes: bigint): bigint {
  const free = BigInt(DB_CAPACITY_FREE_TIER_BYTES);
  return peakBytes > free ? peakBytes - free : BigInt(0);
}

/**
 * 月次請求額を計算する (階段関数型: 1GB tier × ¥50)。
 *
 * 仕様 (ADR-0020 §2.2):
 *   - 0 ~ 50MB: ¥0
 *   - 51MB ~ 1,050MB: ¥50 (1 tier)
 *   - 1,051MB ~ 2,050MB: ¥100 (2 tier)
 *   - 2,051MB ~ 3,050MB: ¥150 (3 tier)
 *   - ...
 *
 * バイト単位の繰り上げ:
 *   - 0.1MB / 0.5MB 等の小数 MB は次の MB に繰上 (= bytes → MB ceil)
 *   - 超過バイトが 1 でもあれば 1 tier (¥50) 発生
 *
 * @param peakBytes 月中 peak バイト数
 * @returns 円単位の請求額 (整数)
 */
export function calculateOverageJpy(peakBytes: bigint): number {
  const billableBytes = calculateBillableBytes(peakBytes);
  if (billableBytes === BigInt(0)) return 0;
  // 1MB 単位で ceil (小数 MB は繰上、最小 1MB)
  const billableMb = Number((billableBytes + BigInt(SI_MB_BYTES - 1)) / BigInt(SI_MB_BYTES));
  // 1GB (= 1000MB) tier で ceil
  const gbTiers = Math.ceil(billableMb / 1000);
  return gbTiers * DB_CAPACITY_PRICE_JPY_PER_GB_TIER;
}

/**
 * Stripe Meter 送信用の quantity (= 計算済み costJpy 整数)。
 *
 * R6 で確定した「Stripe Meter 単位 = ¥1 / unit」方式。
 * costJpy を整数のまま送信することで、Stripe 側丸めと JS 側計算が完全一致し
 * ApiCallLog SUM = Stripe Meter invariant を保証する。
 */
export function calculateStripeMeterQuantity(costJpy: number): number {
  return Math.max(0, Math.floor(costJpy));
}

/**
 * 4 層防御の Level 判定 (peak bytes から L1-L3 のどこに到達しているか)。
 *
 * @param peakBytes 月中 peak バイト数
 * @returns 'none' | 'l1' | 'l2' | 'l3' (l3 はハードキャップ到達)
 */
export type DbCapacityWarningLevel = 'none' | 'l1' | 'l2' | 'l3';

export function classifyDbCapacityLevel(peakBytes: bigint): DbCapacityWarningLevel {
  if (peakBytes >= BigInt(DB_CAPACITY_L3_HARD_CAP_BYTES)) return 'l3';
  if (peakBytes >= BigInt(DB_CAPACITY_L2_ADMIN_ALERT_BYTES)) return 'l2';
  if (peakBytes >= BigInt(DB_CAPACITY_L1_USER_WARNING_BYTES)) return 'l1';
  return 'none';
}

/**
 * 環境変数 DB_INSTANCE_ALERT_THRESHOLD_BYTES で alert 閾値を上書き可能にする。
 * 未設定なら compute サイズに応じたデフォルト値を返す。
 *
 * @param computeSize Supabase Compute サイズ (env SUPABASE_COMPUTE_SIZE で指定、default 'micro')
 */
export function getInstanceAlertThresholdBytes(): number {
  const envOverride = process.env['DB_INSTANCE_ALERT_THRESHOLD_BYTES'];
  if (envOverride != null && envOverride !== '') {
    const parsed = Number(envOverride);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const computeSize = (process.env['SUPABASE_COMPUTE_SIZE'] ?? 'micro').toLowerCase();
  return DB_INSTANCE_ALERT_THRESHOLDS_BY_COMPUTE[computeSize] ?? DB_INSTANCE_ALERT_THRESHOLDS_BY_COMPUTE['micro']!;
}
