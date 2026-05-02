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
  /** Voyage AI 軽量 embedding モデル (Phase 2 で使用、1536 次元、Anthropic 互換)。 */
  EMBEDDING: 'voyage-3-lite',
} as const;

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
