/**
 * Embedding 系 featureUnit のプラン別単価定数 (ADR-0022 / 2026-06-01)
 *
 * 役割:
 *   `EMBEDDING_BILLABLE_FEATURE_UNITS` (= knowledge / risk-issue / retrospective / memo / chat /
 *   external-import / attachment-embedding) のプラン別 ¥/call を単一の真実源として定義する。
 *   `withMeteredLLM` の cost 計算分岐がこれを参照し、ApiCallLog.costJpy に記録する。
 *
 * 設計判断 (ADR-0022 / 単価は ADR-0029 で ¥1 → ¥5 改定 / 2026-05-30):
 *   - **Beginner ¥0 維持**: 「90 日完全無料」訴求 (LP / api-usage-guide.md §1) を保つため、
 *     Beginner プランは Embedding も無料。Beginner 50 件月次上限 (= LLM 系のみカウント) と
 *     5 席制限・90 日試用・同一メール再払出不可制約の中で運用される。
 *   - **Expert / Pro 共通 ¥5/call** (ADR-0029 / 2026-05-30 改定、旧 ¥1): 全プラン均一の ¥5 単価。
 *     Embedding は plan 間で品質差がない (= 同一 Voyage モデルを使用) ため plan 依存にする意味が
 *     薄く、シンプルさを優先。
 *   - **¥5 の根拠**: Voyage 実コスト ¥0.036/call の約 139 倍。事業者の Voyage 200M 無料枠を
 *     食い潰されても損失せず、課金経路を立てつつテナント負担も小さい価格帯。
 *   - **Client-safe 定数ファイル**: Prisma 等のサーバ専用ライブラリを import せず、Client
 *     Component からも安全に参照可能 (feedback_client_service_boundary.md 遵拠)。
 *   - **bulk 操作の課金単位**: external-import-embedding 等の bulk は generateBatchEmbeddings で
 *     N 件処理しても 1 ApiCallLog = 1 課金単位。100 件 CSV 取込でも ¥5。
 *     これは withMeteredLLM が 1 度だけ呼ばれる構造で実現 (= feedback_bulk_llm_call_unit.md)。
 *
 * 関連:
 *   - ADR: docs/adr/0022-embedding-usage-based-billing.md (初版 ¥1)
 *          docs/adr/0029-embedding-price-revision-5jpy.md (¥1 → ¥5 改定)
 *   - Stripe 実設定: docs/design/STRIPE_EMBEDDING_PRICE_SETTINGS.md
 *   - 課金分類: src/config/billing-feature-units.ts (EMBEDDING_BILLABLE_FEATURE_UNITS)
 *   - 課金エンジン: src/lib/llm/metered.ts (本関数の呼出元)
 *   - LLM 単価 (比較対象): src/config/llm.ts resolveCostForPlan()
 *   - Memory: feedback_billing_invariant.md (ApiCallLog SUM = 表示 = 請求 invariant)
 */

import type { TenantPlan } from '@/lib/tenant';

/**
 * Embedding 系 featureUnit のプラン別単価 (円整数)。ADR-0022 (2026-06-01) で導入、
 * ADR-0029 (2026-05-30) で Expert/Pro を ¥1 → ¥5 に改定。
 *
 * 値はテナント間で固定 (= LLM 単価のように `pricePerCallHaiku/Sonnet` をテナント単位で
 * 上書き可能にする設計は **採用しない**)。Embedding は plan 間で品質差がなく、また
 * Voyage 実コストも plan 不依存のため、テナント単位のカスタマイズ余地は不要。
 * 将来 plan 別単価を変更する場合は本定数を更新 + ADR で履歴管理する。
 *
 * ★請求 invariant★: 本定数 (invoice/bank_transfer の ApiCallLog.costJpy SUM) と
 * Stripe Price 単価 (credit_card の Meter quantity × 単価) は必ず一致させること
 * (feedback_billing_invariant.md / docs/design/STRIPE_EMBEDDING_PRICE_SETTINGS.md)。
 */
export const EMBEDDING_PRICE_JPY_BY_PLAN: Record<TenantPlan, number> = {
  beginner: 0,
  expert: 5,
  pro: 5,
} as const;

/**
 * 指定プランの Embedding per-call 単価を返す (円整数)。
 *
 * 使用例 (withMeteredLLM 内):
 *   ```ts
 *   if (isEmbeddingBillableFeatureUnit(featureUnit)) {
 *     const cost = resolveEmbeddingCostJpy(tenant.plan);
 *     // Beginner なら cost=0 (= ApiCallLog のみ記録、Stripe queue 不投入)
 *     // Expert/Pro なら cost=5 (= ApiCallLog + counter + Stripe queue 投入、ADR-0029)
 *   }
 *   ```
 *
 * @param plan テナントの現プラン ('beginner' | 'expert' | 'pro')
 * @returns 単価 (円整数)
 */
export function resolveEmbeddingCostJpy(plan: TenantPlan): number {
  return EMBEDDING_PRICE_JPY_BY_PLAN[plan];
}
