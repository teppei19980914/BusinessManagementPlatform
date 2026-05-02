/**
 * LLM (Anthropic Claude / Voyage AI Embedding) 関連の定数 (PR #2-c / T-03)
 *
 * 設計書: docs/design/SUGGESTION_ENGINE.md
 *
 * 設計判断:
 *   - モデル名は config に外出しすることで、Anthropic 側のバージョンアップ
 *     (例: claude-haiku-4-5 → claude-haiku-4-6) で本ファイルだけ更新すれば
 *     コード全体に伝播する。
 *   - 短期 rate limit の数値は SUGGESTION_ENGINE_PLAN.md PR #2 章から転記。
 *     プロダクション運用での tuning は、本定数を変更してデプロイで反映する。
 */

/**
 * 各 LLM モデル名 (Anthropic / Voyage AI)。
 * Tenant.plan に応じて withMeteredLLM が自動選択する:
 *   - beginner / expert → HAIKU
 *   - pro               → SONNET
 */
export const LLM_MODELS = {
  /** Claude Haiku — Beginner / Expert プランで使用 (低コスト・高速)。 */
  HAIKU: 'claude-haiku-4-5',
  /** Claude Sonnet — Pro プランで使用 (高品質・深い推論)。 */
  SONNET: 'claude-sonnet-4-6',
  /**
   * Voyage AI 軽量 embedding モデル (Phase 2、1024 次元)。
   *
   * 2026-05-02 更新: 当初選定の `voyage-3-lite` は旧世代化し無料枠が失効したため、
   * 公式推奨の新世代 `voyage-4-lite` に切り替え。新世代は **200M トークンが無料**
   * (3-lite は無料枠なし $0.02/M)。品質・コンテキスト長・レイテンシ・スループット
   * 全面で 3 系を上回ると公式に明記されている。
   *
   * 公式: https://docs.voyageai.com/docs/pricing
   *      https://docs.voyageai.com/docs/embeddings
   */
  EMBEDDING: 'voyage-4-lite',
} as const;

/**
 * Voyage AI Embedding のベクトル次元 (voyage-4-lite default)。
 *
 * Prisma schema の `content_embedding vector(EMBEDDING_DIMENSIONS)` と完全に同期させること。
 * 値を変更する場合は migration の vector カラム + 既存データの再生成が必要。
 */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * 短期 rate limit のしきい値 (1 ユーザあたり)。
 * 提案エンジン v2 設計時の既定値。本値を超えると `withMeteredLLM` は
 * 縮退モード (`reason: 'rate_limited'`) で結果を返し、LLM 呼び出しを行わない。
 *
 * 数値根拠:
 *   - 1 分 10 回: 通常操作 (画面で「提案ボタン」を高速連打) を許容しつつ、
 *     bot 級の連打を防ぐ。
 *   - 1 時間 60 回: ユーザ単位での持続的負荷を抑える (Beginner 月 100 回上限と
 *     ほぼ同等のペースで配分される)。
 */
export const LLM_RATE_LIMIT = {
  /** 1 ユーザ / 1 分あたり最大呼び出し回数。 */
  PER_MINUTE: 10,
  /** 1 ユーザ / 1 時間あたり最大呼び出し回数。 */
  PER_HOUR: 60,
} as const;

/**
 * Tenant.plan の各プランで使われるモデル名を返す。
 * `withMeteredLLM` 内で参照される単一の判別ロジック。
 */
export function resolveModelForPlan(plan: 'beginner' | 'expert' | 'pro'): string {
  switch (plan) {
    case 'pro':
      return LLM_MODELS.SONNET;
    case 'beginner':
    case 'expert':
      return LLM_MODELS.HAIKU;
  }
}

/**
 * Tenant の per-call 課金額を返す (円)。
 *   - beginner: ¥0 (無料、ただし月間呼び出し回数上限あり)
 *   - expert:   tenant.pricePerCallHaiku (default ¥10)
 *   - pro:      tenant.pricePerCallSonnet (default ¥30)
 */
export function resolveCostForPlan(
  plan: 'beginner' | 'expert' | 'pro',
  prices: { pricePerCallHaiku: number; pricePerCallSonnet: number },
): number {
  switch (plan) {
    case 'beginner':
      return 0;
    case 'expert':
      return prices.pricePerCallHaiku;
    case 'pro':
      return prices.pricePerCallSonnet;
  }
}
