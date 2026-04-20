/**
 * 提案型サービス (核心機能) のスコアリング定数 (PR #75 Phase 1):
 *
 *   新規プロジェクト作成時のナレッジ / 過去課題 / 振り返り提案で使う重み・閾値。
 *   tuning 対象の数値を service 層から分離し、チューニング履歴を追いやすくする。
 *
 * 設計書参照:
 *   DESIGN.md §23 (核心機能: 提案型サービス)
 */

/** タグ交差 (Jaccard) のスコア寄与重み。TEXT_WEIGHT との合計が 1 になるよう設計。 */
export const SUGGESTION_TAG_WEIGHT = 0.5;

/** テキスト類似度 (pg_trgm) のスコア寄与重み。TAG_WEIGHT との合計が 1 になるよう設計。 */
export const SUGGESTION_TEXT_WEIGHT = 0.5;

/** 候補を最終的に残す閾値 (ノイズカット)。ユーザが見るリストに意味のない 0 付近を並べない。 */
export const SUGGESTION_SCORE_THRESHOLD = 0.05;

/** 各カテゴリの最大件数。提案量が多すぎて読まれないのを防ぐ。 */
export const SUGGESTION_DEFAULT_LIMIT = 10;
