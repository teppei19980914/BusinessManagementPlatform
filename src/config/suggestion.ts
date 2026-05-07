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

/**
 * 候補を最終的に残す閾値。
 *
 * **PR-X6 (2026-05-07) で変更**: 0.05 → 0.01。
 *   従来は「明らかに関連するもののみ提案」する高精度・低再現率設計だったが、
 *   サービスの存在意義 (「人間が探さずに済む」「取りこぼし防止」) と矛盾するため、
 *   閾値を実質ゼロまで下げ、**全網羅 + 段階表示** の高再現率設計に変更。
 *
 *   弱関連 (weak tier) は UI 上では折りたたみ表示で情報過多を回避する。
 */
export const SUGGESTION_SCORE_THRESHOLD = 0.01;

/**
 * 各カテゴリの最大件数。
 *
 * **PR-X6 (2026-05-07) で変更**: 10 → 50。
 *   段階表示で可読性を確保しつつ、網羅性を最大化するため上限を緩和。
 *   weak tier は折りたたみ表示でフロント側の情報過多を防ぐ。
 */
export const SUGGESTION_DEFAULT_LIMIT = 50;

/**
 * 段階表示の閾値: 強く関連 (strong tier) のしきい。
 * これ以上のスコアは UI で「強く関連」セクションに表示される。
 * PR-X6 (2026-05-07) で導入。
 */
export const SUGGESTION_TIER_STRONG_THRESHOLD = 0.3;

/**
 * 段階表示の閾値: 関連の可能性 (medium tier) のしきい。
 * これ以上 < SUGGESTION_TIER_STRONG_THRESHOLD は「関連の可能性」セクション。
 * これ未満は「弱い関連性」セクションで折りたたみデフォルト。
 * PR-X6 (2026-05-07) で導入。
 */
export const SUGGESTION_TIER_MEDIUM_THRESHOLD = 0.1;

/**
 * 最低件数保証 (PR-X6 / 2026-05-07 ユーザ要望対応)。
 *
 * シードデータと完全に異なる業務領域 (例: 養蜂・葬儀・林業) のプロジェクトに対しても、
 * **必ずこの件数の候補を返す** ための保証ロジック。閾値以上の候補が本数値未満の場合、
 * 閾値を無視してスコア降順 Top N (= この件数) を返す。
 *
 * ユーザ要望 (2026-05-07): 「初めてのユーザが 1 件目にどんなプロジェクトを登録しても
 * 必ず hit する」「提案件数が 0 件とならないように考慮」。
 *
 * 動作:
 *   - 閾値以上の候補が本数値以上なら通常通り (フィルタ + ソート)
 *   - 閾値以上の候補が本数値未満なら、全候補からスコア降順 Top N を返す
 *   - 候補総数が本数値未満なら全件返す
 *
 * 設計判断: 5 件 (UI 上で 1 画面で読める範囲、シードが豊富 = 必ず 5 件は存在する前提)。
 */
export const SUGGESTION_MINIMUM_GUARANTEED_COUNT = 5;

/**
 * 提案候補の段階分類。
 * - 'strong': 強く関連 (score >= SUGGESTION_TIER_STRONG_THRESHOLD)
 * - 'medium': 関連の可能性 (SUGGESTION_TIER_MEDIUM_THRESHOLD <= score < strong)
 * - 'weak'  : 弱い関連性 (score < SUGGESTION_TIER_MEDIUM_THRESHOLD)
 */
export type SuggestionTier = 'strong' | 'medium' | 'weak';

/**
 * スコアから tier を計算する。PR-X6 で導入。
 */
export function classifyTier(score: number): SuggestionTier {
  if (score >= SUGGESTION_TIER_STRONG_THRESHOLD) return 'strong';
  if (score >= SUGGESTION_TIER_MEDIUM_THRESHOLD) return 'medium';
  return 'weak';
}

/**
 * 候補リストに最低件数保証を適用する (PR-X6)。
 *
 * @param candidates 全候補 (スコア降順を想定)
 * @param threshold 閾値 (これ以上のスコアを「正規候補」と判定)
 * @param minimum 最低保証件数 (= SUGGESTION_MINIMUM_GUARANTEED_COUNT)
 * @returns 表示する候補の配列
 */
export function applyMinimumGuarantee<T extends { score: number }>(
  candidates: ReadonlyArray<T>,
  threshold: number = SUGGESTION_SCORE_THRESHOLD,
  minimum: number = SUGGESTION_MINIMUM_GUARANTEED_COUNT,
): T[] {
  const aboveThreshold = candidates.filter((c) => c.score >= threshold);
  // 閾値以上の候補が最低件数を満たすなら通常通り
  if (aboveThreshold.length >= minimum) return aboveThreshold;
  // 候補総数が最低件数未満なら全件
  if (candidates.length <= minimum) return [...candidates];
  // 閾値以上が不足する場合、全候補のスコア降順 Top minimum を返す
  return [...candidates].sort((a, b) => b.score - a.score).slice(0, minimum);
}

/**
 * 提案機能の **緊急停止フラグ** (PR #8 / T-03 リリース準備)。
 *
 * 環境変数 `SUGGESTION_ENGINE_DISABLED=true` を設定すると、提案機能が完全に停止する:
 *   - 提案画面で空配列が返却される (UI には「提案なし」と表示)
 *   - LLM (Anthropic / Voyage) も呼ばれない
 *   - 既存のプロジェクト作成・ナレッジ管理など他機能は無傷
 *
 * 想定ユースケース:
 *   - LLM API の障害で大量エラーが発生し、緊急停止したい
 *   - 月次予算超過で全テナントへの課金を即座に止めたい
 *   - リグレッション発見時に問題切り分けで一時無効化したい
 *
 * 設計判断:
 *   - **DB フラグではなく環境変数**: 障害時に DB アクセスができない可能性があるため、
 *     Vercel 環境変数で即時切替可能な仕組みを採用。
 *   - **デフォルト false**: 設定なし = 提案機能有効 (通常運用)。
 *   - **テナント別ではなく全体フラグ**: 緊急停止は全体一括でよい (テナント別なら DB 操作)。
 */
export function isSuggestionEngineDisabled(): boolean {
  return process.env.SUGGESTION_ENGINE_DISABLED === 'true';
}
