/**
 * DB 容量モニタの定数・閾値 (P-5a / 2026-05-08)
 *
 * 役割:
 *   super_admin ダッシュボードで PostgreSQL の使用容量を可視化し、
 *   プラン上限到達による「データ登録不能」事故を未然に防ぐための閾値定義。
 *
 * 設計判断:
 *   - **`pg_database_size()` を直接照会** する方針 (Supabase Management API 不使用)。
 *     - Supabase API は per-project の合計しか返せず、テーブル別内訳が取れない
 *     - DATABASE_URL があれば動作 (= Personal Access Token 取得不要)
 *     - 移植性: 任意の Postgres 提供者で動作 (Supabase 固有依存なし)
 *   - **環境変数で上限を指定可能**: 将来 Supabase Pro (8GB) / Team (500GB) に
 *     アップグレードしても再デプロイ不要で閾値を切替えられる。
 *   - **デフォルトは Free プラン (500MB) 想定**: コスト最適化中の現在の運用前提。
 *
 * 関連:
 *   - サービス: src/services/db-capacity.service.ts
 *   - 計画: docs/roadmap/V1_FINAL_TASKS.md P-5
 */

/**
 * DB 容量上限 (バイト)。
 *
 * 環境変数 `DB_CAPACITY_LIMIT_BYTES` で上書き可能 (例: Pro プラン 8GB なら 8589934592)。
 * 未設定時は Supabase Free プラン (500 MB) を使用。
 */
export function getDbCapacityLimitBytes(): number {
  const env = process.env.DB_CAPACITY_LIMIT_BYTES;
  if (env != null && env !== '') {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DB_CAPACITY_DEFAULT_LIMIT_BYTES;
}

/** デフォルト上限: Supabase Free プランの 500 MB */
export const DB_CAPACITY_DEFAULT_LIMIT_BYTES = 500 * 1024 * 1024;

/**
 * 警告しきい値 (使用率)。これ以上で「黄色 (要注意)」表示。
 * 80% は「あと 20% で残量切れ」の早期検知ライン (Supabase 提案値)。
 */
export const DB_CAPACITY_WARN_THRESHOLD = 0.8;

/**
 * アラートしきい値 (使用率)。これ以上で「赤色 (緊急)」表示。
 * 90% を超えると Supabase が部分的に書き込み制限をかけ始めるリスクがあるため、
 * 余裕をもって 90% で警告。
 */
export const DB_CAPACITY_ALERT_THRESHOLD = 0.9;

/** super_admin 画面で表示する「テーブル別内訳」の上位件数 (最大 N 件)。 */
export const DB_CAPACITY_TOP_TABLES_LIMIT = 10;

/** 容量ステータスの 3 段階分類。 */
export type DbCapacityStatus = 'ok' | 'warn' | 'alert';

/**
 * 使用率からステータスを判定する。
 *
 * - ratio < WARN_THRESHOLD (80%) : 'ok'
 * - WARN_THRESHOLD <= ratio < ALERT_THRESHOLD (90%) : 'warn'
 * - ratio >= ALERT_THRESHOLD : 'alert'
 */
export function classifyDbCapacityStatus(usedBytes: number, limitBytes: number): DbCapacityStatus {
  if (limitBytes <= 0) return 'ok'; // 上限不明なら ok 扱い (defensive)
  const ratio = usedBytes / limitBytes;
  if (ratio >= DB_CAPACITY_ALERT_THRESHOLD) return 'alert';
  if (ratio >= DB_CAPACITY_WARN_THRESHOLD) return 'warn';
  return 'ok';
}
