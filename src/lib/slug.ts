/**
 * 組織 ID (Tenant.slug) の数字連番採番ヘルパー
 * (feat/signup-friction-reduction / 2026-06-12)
 *
 * 設計 (2026-06-12 改訂): 公開サインアップ (/signup) では組織 ID をユーザに入力させず、
 *   **作成時にサーバが数字連番を自動採番** する (入力欄は非表示)。心理的負荷を最小化し、
 *   「組織 ID を自分で考える」工程そのものを無くす。
 *
 *   - 採番値 = 既存の「純粋な数字 slug」の最大値 + 1 (NUMERIC_SLUG_BASE 以上を保証)。
 *     = 6 桁以上の読みやすい連番 (100001, 100002, ...)。
 *   - 一意性は tenants.slug の UNIQUE 制約で最終担保し、衝突時はサーバ側でリトライ採番する
 *     (tenant-onboarding.service.ts)。
 *
 * 注意: 本ヘルパーは純粋関数 (採番の最大値計算のみ)。DB アクセスは呼出側 (service) が行う。
 */

/** 数字連番の開始値 (十分な桁数を確保: 6 桁)。 */
export const NUMERIC_SLUG_BASE = 100000;

/**
 * 既存の数字 slug の最大値から、次に採番すべき数字 slug (number) を返す。
 * NUMERIC_SLUG_BASE 以上を必ず保証する。
 *
 * @param maxNumeric 既存の純粋数字 slug の最大値 (無ければ 0 / null 相当)
 */
export function nextNumericSlug(maxNumeric: number): number {
  const safeMax = Number.isFinite(maxNumeric) && maxNumeric > 0 ? Math.floor(maxNumeric) : 0;
  return Math.max(safeMax, NUMERIC_SLUG_BASE - 1) + 1;
}
