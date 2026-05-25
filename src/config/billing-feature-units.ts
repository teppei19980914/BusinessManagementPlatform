/**
 * 課金対象 featureUnit の中央定義 (ADR-0019 / 2026-05-24)
 *
 * 役割:
 *   ApiCallLog.featureUnit 値のうち「テナント課金対象」となるものを単一の真実源として定義する。
 *   `withMeteredLLM` (= src/lib/llm/metered.ts) はこの配列を参照し、以下の分岐を行う:
 *
 *     - **課金対象 (billable)**: costJpy = resolveCostForPlan(plan, ...) を計上、
 *       Tenant.currentMonthApiCallCount / currentMonthApiCostJpy を increment、
 *       Stripe Usage Record Queue に enqueue。
 *     - **無料 (free)**: costJpy = 0 で ApiCallLog のみ記録、counter increment なし、
 *       Stripe queue 投入なし。Beginner 月次上限のカウントにも含まれない。
 *
 * 設計判断 (ADR-0019):
 *   - **実コスト差に基づく分類**: LLM (Claude Haiku/Sonnet) を呼ぶ操作は実コスト ¥0.5-6/call、
 *     Embedding (Voyage voyage-4-lite) のみの操作は実コスト ¥0.036/call で 50-150x の差がある。
 *     かつ Voyage は月 200M tokens の無料枠 (アカウント単位) があり、実運用スケールでは
 *     embedding は実コスト ¥0 で運用できる。これに合わせ Embedding のみの呼出は全プラン無料化。
 *   - **中央定義**: featureUnit 値が散在すると「あるサービスを無料化したつもりが Stripe には投入され続けた」
 *     という drift を起こすため、本ファイルで一括管理する。
 *   - **ApiCallLog は無料 call も記録**: 監査 / 利用分析 / fair use limit のカウント / 将来の課金復活時の
 *     根拠データに使う。記録自体は省略しない。
 *
 * 関連:
 *   - ADR: docs/adr/0019-billable-feature-units-and-free-tier-expansion.md
 *   - 課金エンジン: src/lib/llm/metered.ts (本配列の参照元)
 *   - 単価: src/config/llm.ts resolveCostForPlan()
 *   - Fair use limit (無料 call の暴走防止): src/services/fair-use-limit.service.ts
 *   - Memory: feedback_billing_invariant.md (ApiCallLog SUM = 表示 = 請求 invariant)
 */

/**
 * 課金対象 featureUnit の集合 (ADR-0019 / 2026-05-24)。
 *
 * - `project-upsert`: プロジェクト作成/更新時の auto-tag (LLM) + embedding を 1 ApiCallLog に集約。
 *   plan 依存単価で課金 (Beginner 上限カウント / Expert ¥10 / Pro ¥15)。
 * - `suggestion-explanation`: なぜ?機能 (Pro 限定の LLM 呼出)。Pro のみ ¥15/call で課金。
 * - `auto-tag-extract`: スタンドアロン auto-tag (= project-upsert の集約外で呼ばれる場合)。
 *   実コードでは現状 project.service.ts の `extractTagsAndEmbedForProject` 経由のみ。
 *   将来単独利用される可能性に備えて課金対象として残す ([src/services/auto-tag.service.ts:309](../services/auto-tag.service.ts) に extractAutoTags() が export 済)。
 *
 * 上記以外の featureUnit (`{knowledge,risk-issue,retrospective,memo}-embedding`,
 * `chat-semantic-search`, `*-embedding-backfill`, `external-import-embedding`) は **無料**。
 */
export const BILLABLE_FEATURE_UNITS = [
  'project-upsert',
  'suggestion-explanation',
  'auto-tag-extract',
] as const;

export type BillableFeatureUnit = (typeof BILLABLE_FEATURE_UNITS)[number];

/**
 * 指定された featureUnit が課金対象かどうかを判定する。
 *
 * `withMeteredLLM` が以下のように使用する:
 *   if (isBillableFeatureUnit(featureUnit)) {
 *     // 通常課金フロー (cost > 0, counter increment, Stripe queue enqueue)
 *   } else {
 *     // 無料フロー (cost = 0, counter 不変, Stripe queue 投入なし)
 *   }
 *
 * 引数の型を `string` にしているのは、ApiCallLog.featureUnit が DB 上 VARCHAR(40) で
 * type-safe な enum ではないため。未知の値が来た場合は安全側で「課金しない」(= false) を返す。
 */
export function isBillableFeatureUnit(featureUnit: string): featureUnit is BillableFeatureUnit {
  return (BILLABLE_FEATURE_UNITS as readonly string[]).includes(featureUnit);
}
