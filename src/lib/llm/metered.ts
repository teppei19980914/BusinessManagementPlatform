/**
 * `withMeteredLLM()` — LLM 呼び出しの計測 + 認可 + 縮退判定ミドルウェア
 * (PR #2-c / T-03 提案エンジン v2、ADR-0019 で billable/free 分岐を追加 / 2026-05-24
 *  → ADR-0022 で 4 階層分類に拡張 / 2026-06-01)
 *
 * 役割:
 *   提案エンジンや自動タグ抽出など **すべての LLM/Embedding 呼び出し** を本ミドルウェア越しに
 *   行う。漏れを構造的に防ぐため、サービス層で直接 anthropic-sdk / voyage を叩くのではなく、
 *   必ず本関数で wrap する。
 *
 *   ADR-0022 (2026-06-01) 4 階層分類:
 *     1. **LLM_BILLABLE** (project-upsert / suggestion-explanation / auto-tag-extract):
 *        cost = resolveCostForPlan(plan) [Beginner=0 / Expert=¥10 / Pro=¥15]
 *        counter = currentMonthApi*
 *        Beginner 50 件月次上限 + monthlyBudgetCap 判定対象
 *        Stripe queue = haiku/sonnet event
 *     2. **EMBEDDING_BILLABLE** (knowledge-embedding / risk-issue-embedding / retrospective-embedding /
 *        memo-embedding / chat-semantic-search / external-import-embedding / attachment-embedding):
 *        cost = resolveEmbeddingCostJpy(plan) [Beginner=0 / Expert=¥5 / Pro=¥5、ADR-0029]
 *        counter = currentMonthEmbedding* (全プラン件数記録、Beginner は cost=0 でも count は記録)
 *        Beginner 上限 / budget cap 判定対象外 (= 既存上限ロジック不変)
 *        Stripe queue = embedding event (cost > 0 のときのみ = Beginner はスキップ)
 *     3. **EMBEDDING_BACKFILL** (cron 自動リカバリ): cost=0 / counter 不変 / queue 不投入。
 *        ユーザ非起動の処理での課金は「不当請求」 = UX/信頼関係に直接影響するため明示的 free。
 *     4. **その他** (未知 featureUnit): cost=0 / counter 不変 / queue 不投入 (安全側)。
 *
 * 実行ステップ:
 *   1. 短期 rate limit (1 ユーザ / 1 分 / 10 回、1 ユーザ / 1 時間 / 60 回) — 全 featureUnit 対象
 *   2. Tenant 取得 + plan 解決
 *   3. Beginner プランの月間呼び出し回数上限チェック (**LLM_BILLABLE のみ**)
 *   3.1. Beginner プラン Embedding 月間試用上限チェック (**EMBEDDING_BILLABLE のみ**、ADR-0030)
 *   3.5. Fair Use Limit チェック (**Beginner プラン × EMBEDDING_BILLABLE のみ**、Voyage 無料枠保護、ADR-0030 後は safety net)
 *   4. monthlyBudgetCapJpy 設定時の予測コスト超過チェック (**LLM_BILLABLE のみ**)
 *   4.1. monthlyEmbeddingBudgetCapJpy 設定時の予測コスト超過チェック (**EMBEDDING_BILLABLE のみ**、ADR-0030)
 *   5. 実 LLM 呼び出し (caller の callback)
 *   6. 成功時に ApiCallLog 記録 (全 featureUnit) + Tenant counter increment (4 階層分岐) +
 *      Stripe queue enqueue (LLM_BILLABLE or EMBEDDING_BILLABLE で cost > 0 のとき)
 *
 * 縮退モード (LLM 呼び出しを行わず即返却):
 *   - rate_limited: 短期 rate limit 超過
 *   - tenant_inactive: Tenant 削除済 (deletedAt != null) または存在しない
 *   - beginner_limit_exceeded: Beginner 月間 50 回 (default、ADR-0019) 超過 (LLM_BILLABLE call のみカウント)
 *   - embedding_beginner_limit_exceeded: Beginner 月間 100 件 Embedding 試用上限 (ADR-0030) 超過
 *   - fair_use_limit_exceeded: Beginner 月間 10,000 calls (Embedding) 超過 (ADR-0022 / ADR-0030 後 safety net)
 *   - budget_exceeded: ユーザ自己設定の monthlyBudgetCapJpy 超過予測 (LLM_BILLABLE のみ判定)
 *   - embedding_budget_exceeded: ユーザ自己設定の monthlyEmbeddingBudgetCapJpy 超過予測 (EMBEDDING_BILLABLE のみ判定、ADR-0030)
 *
 * 失敗モード (LLM 呼び出しが投げた場合):
 *   - llm_error: 内部例外。caller 側でフォールバック (既存スコアリング等) する想定。
 *     **失敗時はカウンタを進めない** ため、ユーザは料金を課されない。
 *
 * 設計判断:
 *   - userId は optional (undefined = cron / システム実行)。userId なし時は
 *     rate limit をスキップ (admin 責任で別途制御)。
 *   - 予測コストは options.predictedCostJpy で上書き可能 (embedding 等で
 *     per-call 価格と差がある特殊ケース用)。デフォルトは plan 単価 (LLM_BILLABLE 時のみ計上)。
 *   - increment と ApiCallLog 記録は単一 transaction で実行 (整合性担保)。
 *     transaction 失敗は内部エラーとして throw — caller がエラー処理。
 *   - 課金対象判定は 4 つの型ガード (isLlmBillable / isEmbeddingBillable / isEmbeddingBackfill /
 *     isStorageOverage) で行う。これらが ApiCallLog SUM / 画面表示 / Stripe queue / 請求書 の
 *     5 経路で参照される単一の真実源 (feedback_billing_invariant.md)。
 *
 * 関連:
 *   - 設計: docs/design/SUGGESTION_ENGINE.md
 *   - 課金分類: src/config/billing-feature-units.ts (4 階層 + 判定関数)
 *   - Embedding 単価: src/config/embedding-pricing.ts (resolveEmbeddingCostJpy)
 *   - LLM 単価: src/config/llm.ts (resolveCostForPlan)
 *   - ADR: docs/adr/0019-billable-feature-units-and-free-tier-expansion.md
 *          docs/adr/0022-embedding-usage-based-billing.md
 *          docs/adr/0029-embedding-price-revision-5jpy.md (Embedding ¥5/call)
 *          docs/adr/0030-embedding-monthly-budget-cap.md (Embedding 予算上限 + Beginner 100 件試用上限)
 *   - 配下: src/lib/llm/rate-limiter.ts
 *   - Stripe: src/lib/stripe.ts (STRIPE_METER_EVENT_NAMES.embedding)
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import {
  isEmbeddingBackfillFeatureUnit,
  isEmbeddingBillableFeatureUnit,
  isLlmBillableFeatureUnit,
} from '@/config/billing-feature-units';
import {
  resolveEmbeddingCostJpy,
  BEGINNER_EMBEDDING_MONTHLY_LIMIT,
} from '@/config/embedding-pricing';
import {
  LLM_RATE_LIMIT,
  resolveCostForPlan,
  resolveModelForPlan,
} from '@/config/llm';
import { isTenantPlan, type TenantPlan } from '@/lib/tenant';
// ADR-0019 (2026-05-24) → ADR-0022 (2026-06-01) で Beginner プラン限定に縮小:
//   Embedding 系を Expert/Pro で ¥5 課金化したため (ADR-0029)、それらは monthlyBudgetCap で自然防御。
//   Beginner は cost=0 のままで防御手段がないため、本サービスを Beginner プランのみで利用継続。
import { checkFairUseLimit } from '@/services/fair-use-limit.service';
import {
  getDefaultRateLimiter,
  type RateLimiter,
  type RateLimitCheckResult,
} from './rate-limiter';

// ================================================================
// 公開型
// ================================================================

/** withMeteredLLM の入力。 */
export interface WithMeteredLLMOptions {
  /**
   * featureUnit 識別子 (例: 'new-project-suggestion')。
   * api_call_logs.feature_unit に記録され、課金根拠データの主キーになる。
   */
  featureUnit: string;
  /** リクエストユーザの所属テナント ID (NextAuth session.user.tenantId)。 */
  tenantId: string;
  /** リクエストユーザの ID。cron / システム実行時は undefined (rate limit スキップ)。 */
  userId?: string;
  /**
   * 予測コスト (円整数)。明示しない場合は plan 単価を使用。
   * Embedding 専用呼び出しなど、per-call 価格と乖離する場合に上書き。
   */
  predictedCostJpy?: number;
  /** リクエスト ID (省略時は UUID 自動生成)。trace 用。 */
  requestId?: string;
  /** テスト / DI 用の rate limiter 上書き。本番は getDefaultRateLimiter() を使う。 */
  rateLimiter?: RateLimiter;
}

/** caller の callback に渡される実行コンテキスト。 */
export interface MeteredLLMContext {
  /** plan に応じて自動選択されたモデル名 (例: 'claude-haiku-4-5')。 */
  modelName: string;
  /** 当該リクエストの一意 ID (ApiCallLog.requestId と一致)。 */
  requestId: string;
}

/** caller の callback の戻り値。 */
export interface MeteredLLMCallReturn<T> {
  result: T;
  /** トークン使用量。記録のため可能な限り埋めること (なくても可)。 */
  usage?: {
    llmInputTokens?: number;
    llmOutputTokens?: number;
    embeddingTokens?: number;
  };
}

/** 成功時の結果。 */
export interface WithMeteredLLMSuccess<T> {
  ok: true;
  result: T;
  costJpy: number;
  latencyMs: number;
  modelName: string;
  requestId: string;
}

/** 縮退モード (LLM 呼び出しなし)。caller はフォールバック処理を行う。 */
export interface WithMeteredLLMDegraded {
  ok: false;
  reason:
    | 'rate_limited'
    | 'tenant_inactive'
    | 'beginner_limit_exceeded'
    | 'budget_exceeded'
    | 'plan_invalid'
    | 'fair_use_limit_exceeded'
    // ADR-0030 (2026-05-30): Embedding 月次予算上限 + Beginner Embedding 100 件試用上限
    | 'embedding_budget_exceeded'
    | 'embedding_beginner_limit_exceeded';
  retryAfterSec?: number;
  message: string;
}

/** LLM 呼び出し中の例外。 */
export interface WithMeteredLLMFailure {
  ok: false;
  reason: 'llm_error';
  error: unknown;
  message: string;
}

export type WithMeteredLLMResult<T> =
  | WithMeteredLLMSuccess<T>
  | WithMeteredLLMDegraded
  | WithMeteredLLMFailure;

// ================================================================
// 公開関数
// ================================================================

/**
 * LLM 呼び出しを計測 + 認可 + 縮退判定でラップする。
 *
 * @param options featureUnit / tenantId / userId など
 * @param call    実 LLM 呼び出し処理 (modelName を受け取って result を返す)
 */
export async function withMeteredLLM<T>(
  options: WithMeteredLLMOptions,
  call: (ctx: MeteredLLMContext) => Promise<MeteredLLMCallReturn<T>>,
): Promise<WithMeteredLLMResult<T>> {
  const requestId = options.requestId ?? randomUUID();
  const rateLimiter = options.rateLimiter ?? getDefaultRateLimiter();

  // ---------- Step 1: 短期 rate limit (per-user) ----------
  if (options.userId != null) {
    const rateCheck = await checkUserRateLimit(rateLimiter, options.userId);
    if (!rateCheck.allowed) {
      return {
        ok: false,
        reason: 'rate_limited',
        retryAfterSec: rateCheck.retryAfterSec,
        message: 'リクエスト回数の制限を超過しました',
      };
    }
  }

  // ---------- Step 2: Tenant 取得 + plan 解決 ----------
  const tenant = await prisma.tenant.findFirst({
    where: { id: options.tenantId, deletedAt: null },
  });
  if (tenant == null) {
    return {
      ok: false,
      reason: 'tenant_inactive',
      message: 'テナントが存在しないか、無効化されています',
    };
  }

  if (!isTenantPlan(tenant.plan)) {
    return {
      ok: false,
      reason: 'plan_invalid',
      message: 'テナントのプラン値が不正です',
    };
  }
  const plan: TenantPlan = tenant.plan;

  const modelName = resolveModelForPlan(plan);

  // ADR-0022 (2026-06-01) 4 階層分類 + ADR-0027/0028 LEARNING_FREE で featureUnit を判定:
  //   1. LLM_BILLABLE (project-upsert / suggestion-explanation / auto-tag-extract):
  //      plan 別単価、currentMonthApi* counter、Beginner 50 / budget cap 判定対象、
  //      Stripe queue は haiku/sonnet event。
  //   2. EMBEDDING_BILLABLE (knowledge-embedding / risk-issue-embedding / retrospective-embedding /
  //      memo-embedding / chat-semantic-search / external-import-embedding / attachment-embedding):
  //      Beginner=¥0 / Expert=¥5 / Pro=¥5 (ADR-0029)、currentMonthEmbedding* counter、Beginner 上限 / budget cap
  //      判定対象外 (= 既存上限ロジック不変)、Stripe queue は cost > 0 のみ embedding event。
  //   3. EMBEDDING_BACKFILL (cron 自動リカバリ): 全プラン ¥0 維持、counter 不変、Stripe queue 不投入。
  //      ユーザ非起動の処理での課金は「不当請求」 = UX/信頼関係に直接影響するため明示的 free。
  //   4. LEARNING_FREE (help-chat / help-chat-embedding、ADR-0027 / ADR-0028):
  //      下記 4 番目「その他」分岐に **意図的に落ちる** ことで cost=0 / counter 不変 / Stripe 不投入
  //      の安全側挙動を得る。LEARNING_FREE_FEATURE_UNITS は明示判定せず、未追加なのが正解。
  //      `help-chat` は元々 withMeteredLLM を経由しないが、`help-chat-embedding` (RAG query embedding)
  //      は generateBatchEmbeddings 経由で本関数を通る。
  //   5. その他 (= 未知 / 想定外 / LEARNING_FREE): cost=0、counter 不変、Stripe queue 不投入 (安全側)。
  const isLlmBillable = isLlmBillableFeatureUnit(options.featureUnit);
  const isEmbeddingBillable = isEmbeddingBillableFeatureUnit(options.featureUnit);
  const isEmbeddingBackfill = isEmbeddingBackfillFeatureUnit(options.featureUnit);

  // cost 計算: featureUnit カテゴリで分岐。
  //   LLM → resolveCostForPlan(plan): Beginner=0 / Expert=¥10 / Pro=¥15
  //   Embedding → resolveEmbeddingCostJpy(plan): Beginner=0 / Expert=¥5 / Pro=¥5 (ADR-0029)
  //   Backfill / 未知 / LEARNING_FREE (help-chat-embedding 等) → 0 (明示的 free)
  const costJpy = isLlmBillable
    ? resolveCostForPlan(plan, {
        pricePerCallHaiku: tenant.pricePerCallHaiku,
        pricePerCallSonnet: tenant.pricePerCallSonnet,
      })
    : isEmbeddingBillable
      ? resolveEmbeddingCostJpy(plan)
      : 0;

  // ---------- Step 3: Beginner プラン月間上限チェック (LLM_BILLABLE のみ) ----------
  // ADR-0022: Embedding は Beginner 50 件上限を消費しない (= 既存上限ロジック不変)。
  //   「資産入力とチャットは Beginner でも完全無料で無制限」訴求と整合。
  //   Backfill / 未知も対象外。
  if (isLlmBillable && plan === 'beginner') {
    if (tenant.currentMonthApiCallCount >= tenant.beginnerMonthlyCallLimit) {
      return {
        ok: false,
        reason: 'beginner_limit_exceeded',
        message: `Beginner プランの月間 ${tenant.beginnerMonthlyCallLimit} 回上限に達しました`,
      };
    }
  }

  // ---------- Step 3.1: Beginner Embedding 月間試用上限チェック (ADR-0030) ----------
  // ADR-0030 (2026-05-30): Beginner プランの Embedding 系呼出が月 100 件 (BEGINNER_EMBEDDING_MONTHLY_LIMIT) を超えたら停止。
  //   ADR-0022 時点では「Beginner Embedding は無制限」訴求だったが、LP の試用範囲を明示する
  //   ユーザ向け cap を新設。Fair Use Limit (10,000) が先に発火していた状態を解消し、
  //   Beginner cap (100) が先に発火する設計に変更。Fair Use Limit は safety net として残置。
  //   到達時の挙動: 縮退モード。既存 embedding でのチャット検索は継続、新規 embedding 生成のみ停止、
  //   失敗分は月初 backfill cron で次月補填される (ADR-0026 非同期化 + ADR-0022 backfill との整合)。
  //
  // ★severity-high★ race condition + drift リスク (ADR-0030 §Risk):
  //   本 check は tenant snapshot に対するため、Step 6 の counter increment との間に race window がある。
  //   同時並行リクエスト時に最大 N callで cap を +N 超過する可能性あり (= 既存 LLM cap も同設計)。
  //   Beginner cost=0 のため金銭被害なし。drift detection + RepairOwnDriftButton で長期的整合性を保つ。
  if (isEmbeddingBillable && plan === 'beginner') {
    if (tenant.currentMonthEmbeddingCallCount >= BEGINNER_EMBEDDING_MONTHLY_LIMIT) {
      return {
        ok: false,
        reason: 'embedding_beginner_limit_exceeded',
        message: `Beginner プランの月間 Embedding 生成 ${BEGINNER_EMBEDDING_MONTHLY_LIMIT} 回上限に達しました`,
      };
    }
  }

  // ---------- Step 3.5: Fair use limit (Beginner プラン × EMBEDDING_BILLABLE のみ) ----------
  // ADR-0022/0029: Expert/Pro は Embedding が cost=¥5 のため monthlyBudgetCap で自然防御。
  //   Beginner は cost=0 のままで防御手段がないため、Beginner プランの EMBEDDING_BILLABLE 呼出に
  //   対してのみ Fair Use Limit (= 月 10,000 calls/tenant) を適用し Voyage 200M 無料枠を保護。
  //   詳細: src/services/fair-use-limit.service.ts + ADR-0022 §2.3
  // ADR-0030 (2026-05-30): Beginner Embedding 100 件上限が先に発火するため、Fair Use Limit (10,000)
  //   は通常運用では到達しない (= 上記 Step 3.1 で先に停止)。本 Step は Step 3.1 を bypass する
  //   コードバグへの safety net として残置 (= Voyage 無料枠保護の最終防御線)。
  if (plan === 'beginner' && isEmbeddingBillable) {
    const fairUse = await checkFairUseLimit(options.tenantId, tenant.timezone ?? null);
    if (!fairUse.allowed) {
      return {
        ok: false,
        reason: 'fair_use_limit_exceeded',
        message: fairUse.message,
      };
    }
  }

  // ---------- Step 4: monthlyBudgetCapJpy 予測超過チェック (LLM_BILLABLE のみ) ----------
  // ADR-0019: LLM 系 (project-upsert / suggestion-explanation / auto-tag-extract) の自己設定予算上限。
  //   無料 call (= Beginner Embedding / Backfill / 未知) は cost=0 で予算消費しないため判定不要。
  if (isLlmBillable) {
    const predictedCost = options.predictedCostJpy ?? costJpy;
    if (tenant.monthlyBudgetCapJpy != null) {
      if (
        tenant.currentMonthApiCostJpy + predictedCost >
        tenant.monthlyBudgetCapJpy
      ) {
        return {
          ok: false,
          reason: 'budget_exceeded',
          message: `月次予算上限 (${tenant.monthlyBudgetCapJpy} 円) に達するため、これ以上の呼び出しを停止しました`,
        };
      }
    }
  }

  // ---------- Step 4.1: monthlyEmbeddingBudgetCapJpy 予測超過チェック (ADR-0030) ----------
  // ADR-0030 (2026-05-30): Embedding 系専用の自己設定予算上限。
  //   ADR-0022 時点では「Embedding は必須機能のため予算上限と独立」だったが、ADR-0026 非同期化 +
  //   月初 backfill cron + 既存 embedding 継続利用の多層フォールバックが整い、「上限到達 = サービス停止」
  //   ではない設計が成立したため判定対象化。Expert/Pro が Embedding ¥5/call ADR-0029 の月額膨張を
  //   自己制御できる手段として提供。Beginner は cost=0 のため発火しない (= NULL 強制)。
  //
  // ★severity-high★ race + drift リスク (ADR-0030 §Risk):
  //   Step 4 (LLM cap) と同じく snapshot ベース判定のため、race で最大 ¥(N×単価) の超過が発生し得る。
  //   ApiCallLog SUM = 請求書 invariant のため超過分は請求書に正確に反映される。
  //   完全 atomic 化は ADR-0030 スコープ外 (= 将来別 ADR で再検討)。
  if (isEmbeddingBillable) {
    const predictedCost = options.predictedCostJpy ?? costJpy;
    if (tenant.monthlyEmbeddingBudgetCapJpy != null) {
      if (
        tenant.currentMonthEmbeddingCostJpy + predictedCost >
        tenant.monthlyEmbeddingBudgetCapJpy
      ) {
        return {
          ok: false,
          reason: 'embedding_budget_exceeded',
          message: `Embedding 月次予算上限 (${tenant.monthlyEmbeddingBudgetCapJpy} 円) に達するため、これ以上の呼び出しを停止しました`,
        };
      }
    }
  }

  // ---------- Step 5: 実 LLM 呼び出し ----------
  const startMs = Date.now();
  let callResult: MeteredLLMCallReturn<T>;
  try {
    callResult = await call({ modelName, requestId });
  } catch (error) {
    return {
      ok: false,
      reason: 'llm_error',
      error,
      message:
        error instanceof Error ? error.message : 'LLM 呼び出しに失敗しました',
    };
  }
  const latencyMs = Date.now() - startMs;

  // ---------- Step 6: ApiCallLog 記録 + counter increment (4 階層分岐) + Stripe queue ----------
  // ADR-0022 (2026-06-01): ApiCallLog は全 featureUnit で記録するが、Tenant counter increment と
  //   Stripe queue 投入は 4 階層に応じて分岐する:
  //     - isLlmBillable     → currentMonthApi* increment + Stripe queue (haiku/sonnet event)
  //     - isEmbeddingBillable → currentMonthEmbedding* increment + Stripe queue (embedding event、cost > 0 のみ)
  //     - isEmbeddingBackfill → counter 不変 + Stripe queue 不投入 (= ユーザ非起動の明示的 free)
  //     - その他 (未知)      → counter 不変 + Stripe queue 不投入 (安全側)
  //
  //   feedback_billing_invariant.md: 「ApiCallLog SUM = 画面表示 = Stripe 送信 = 請求書 = CSV」
  //   不変条件は維持される (= cost=0 が混ざるだけ、SUM/COUNT は featureUnit ベースで分離集計可能)。
  //
  // PR-S6 (2026-05-14): credit_card テナントは Stripe Usage Record queue にも 1 行追加。
  //   - apiCallLog.id を事前生成 → queue 行で参照 (= idempotency_key 用)
  //   - 同一 transaction で実行する事で「ApiCallLog 作成成功 / queue 未追加」の不整合を防ぐ
  //   - cron (= /api/cron/stripe-usage-flush) が日次で queue → Stripe Meter Event を実送信
  // ADR-0022: callType は featureUnit カテゴリで判定:
  //   - LLM_BILLABLE × Pro → 'sonnet'
  //   - LLM_BILLABLE × 他  → 'haiku'
  //   - EMBEDDING_BILLABLE → 'embedding' (= 新 Meter event 'tasukiba_embedding_call')
  // Stripe-ready 設計: STRIPE_PRICE_EMBEDDING 環境変数未設定でも queue 投入は行う
  //   (= 2026-05-30 以降は Production 設定済みで credit_card テナントへの請求が有効、
  //   将来 env unset に戻しても queue 機構自体は不変で動き続ける)。
  const apiCallLogId = randomUUID();
  const stripeCallType: 'haiku' | 'sonnet' | 'embedding' = isLlmBillable
    ? plan === 'pro'
      ? 'sonnet'
      : 'haiku'
    : 'embedding'; // isEmbeddingBillable のとき。backfill / 未知は shouldEnqueueStripe=false で投入されない
  // ADR-0022 (2026-06-01): Stripe queue 投入は cost > 0 のときのみ。
  //   - Beginner Embedding (cost=0) は投入されない (= 顧客請求対象外)
  //   - Backfill (cost=0) も投入されない (= 明示的 free)
  //   - 未知 featureUnit (cost=0) も投入されない (= 安全側)
  //   - isStripeEnabled() は feature flag (リリース時 false でも本ロジックは不変、
  //     queue は積まれるが flush cron が空 queue を見るだけ。将来有効化で自動動作)。
  const shouldEnqueueStripe =
    (isLlmBillable || isEmbeddingBillable) &&
    costJpy > 0 &&
    tenant.paymentMethod === 'credit_card' &&
    tenant.stripeCustomerId != null;

  // Prisma の $transaction はオーバーロード (配列 / 関数) のため、明示的に配列型として扱う。
  // ApiCallLog は 4 階層すべてで常に記録 (cost=0 が混ざるだけ)。
  const operations: unknown[] = [
    prisma.apiCallLog.create({
      data: {
        id: apiCallLogId,
        tenantId: options.tenantId,
        userId: options.userId,
        featureUnit: options.featureUnit,
        modelName,
        llmInputTokens: callResult.usage?.llmInputTokens,
        llmOutputTokens: callResult.usage?.llmOutputTokens,
        embeddingTokens: callResult.usage?.embeddingTokens,
        costJpy,
        latencyMs,
        requestId,
      },
    }),
  ];
  // ADR-0022: counter increment は 4 階層分岐。
  //   LLM_BILLABLE → currentMonthApi* (Beginner 50 / budget cap 判定用)
  //   EMBEDDING_BILLABLE → currentMonthEmbedding* (全プラン件数記録、Beginner は cost=0 でも count は記録)
  //   Backfill / 未知 → counter 不変
  if (isLlmBillable) {
    operations.unshift(
      prisma.tenant.update({
        where: { id: options.tenantId },
        data: {
          currentMonthApiCallCount: { increment: 1 },
          currentMonthApiCostJpy: { increment: costJpy },
        },
      }),
    );
  } else if (isEmbeddingBillable) {
    operations.unshift(
      prisma.tenant.update({
        where: { id: options.tenantId },
        data: {
          currentMonthEmbeddingCallCount: { increment: 1 },
          currentMonthEmbeddingCostJpy: { increment: costJpy },
        },
      }),
    );
  }
  // isEmbeddingBackfill / 未知: counter 不変 (= 明示的 free、ApiCallLog 記録のみ)。
  // isEmbeddingBackfill は判定済 (= 上記の cost=0 / Stripe queue 不投入の根拠) だが、
  // counter 分岐は「LLM か Embedding か」の 2 択で、それ以外は何もしないため明示分岐不要。
  // ESLint unused-vars 回避のためダミー参照。
  void isEmbeddingBackfill;
  if (shouldEnqueueStripe) {
    operations.push(
      prisma.stripeUsageRecordQueue.create({
        data: {
          tenantId: options.tenantId,
          callType: stripeCallType,
          apiCallLogId,
          quantity: 1,
          occurredAt: new Date(),
          // nextSendAt=now で送信候補になる (= 翌日の日次 cron が拾う)
          nextSendAt: new Date(),
        },
      }),
    );
  }
  // 配列形式の $transaction (= PrismaPromise の配列)。型は内部的に解決される。
  await prisma.$transaction(operations as never);

  return {
    ok: true,
    result: callResult.result,
    costJpy,
    latencyMs,
    modelName,
    requestId,
  };
}

// ================================================================
// 内部ユーティリティ
// ================================================================

/**
 * 1 ユーザに対し PER_MINUTE と PER_HOUR の 2 段 rate limit を順に消費する。
 * いずれか拒否ならその理由を返す (それ以降は消費しない)。
 */
async function checkUserRateLimit(
  rateLimiter: RateLimiter,
  userId: string,
): Promise<RateLimitCheckResult> {
  const minResult = await rateLimiter.check(`llm:${userId}:min`, {
    limit: LLM_RATE_LIMIT.PER_MINUTE,
    windowSec: 60,
  });
  if (!minResult.allowed) return minResult;

  const hourResult = await rateLimiter.check(`llm:${userId}:hour`, {
    limit: LLM_RATE_LIMIT.PER_HOUR,
    windowSec: 3600,
  });
  return hourResult;
}
