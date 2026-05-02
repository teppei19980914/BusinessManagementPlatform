/**
 * 提案型サービス (核心機能) のスコアリング定数:
 *
 *   新規プロジェクト作成時のナレッジ / 過去課題 / 振り返り提案で使う重み・閾値。
 *   tuning 対象の数値を service 層から分離し、チューニング履歴を追いやすくする。
 *
 * 設計書参照:
 *   docs/design/SUGGESTION_ENGINE.md §Phase 2
 *
 * 重み構成 (PR #5-b / T-03 Phase 2 で 3 軸合成に変更):
 *   - SUGGESTION_TAG_WEIGHT     = 0.3 (タグ Jaccard、Phase 1 自動補完で精度向上)
 *   - SUGGESTION_TEXT_WEIGHT    = 0.2 (pg_trgm 文字列類似度、用語の表記揺れに強い)
 *   - SUGGESTION_EMBEDDING_WEIGHT = 0.5 (embedding 意味類似度、用語のゆれ解消の主軸)
 *   合計 1.0。embedding が主軸 (50%) で、タグと pg_trgm は補助。
 *
 *   embedding が NULL の候補 (= まだ生成されていないデータ) は embedding score = 0 で
 *   計算されるため、自動的にタグ + pg_trgm の 2 軸 (合計 0.5) で評価される縮退モードに
 *   なる (= 既存運用と互換)。新規データから順次 embedding が付与されるにつれ提案精度が
 *   上昇する設計。
 */

/** タグ交差 (Jaccard) のスコア寄与重み。 */
export const SUGGESTION_TAG_WEIGHT = 0.3;

/** テキスト類似度 (pg_trgm) のスコア寄与重み。 */
export const SUGGESTION_TEXT_WEIGHT = 0.2;

/**
 * Embedding 類似度 (Voyage AI voyage-4-lite, Cosine Similarity) のスコア寄与重み。
 * PR #5-b (T-03 Phase 2) で導入。embedding が主軸となる。
 */
export const SUGGESTION_EMBEDDING_WEIGHT = 0.5;

/** 候補を最終的に残す閾値 (ノイズカット)。ユーザが見るリストに意味のない 0 付近を並べない。 */
export const SUGGESTION_SCORE_THRESHOLD = 0.05;

/** 各カテゴリの最大件数。提案量が多すぎて読まれないのを防ぐ。 */
export const SUGGESTION_DEFAULT_LIMIT = 10;
