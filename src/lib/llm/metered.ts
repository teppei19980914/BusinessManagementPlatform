/**
 * `withMeteredLLM()` — LLM 呼び出しの計測 + 認可 + 縮退判定ミドルウェア
 * (PR #2-c / T-03 提案エンジン v2)
 *
 * 役割:
 *   提案エンジンや自動タグ抽出など **すべての課金対象 LLM/Embedding 呼び出し** を
 *   本ミドルウェア越しに行う。漏れを構造的に防ぐため、サービス層で直接
 *   anthropic-sdk を叩くのではなく、必ず本関数で wrap する。
 *
 * 実行ステップ (SUGGESTION_ENGINE_PLAN.md PR #2 章より):
 *   1. 短期 rate limit (1 ユーザ / 1 分 / 10 回、1 ユーザ / 1 時間 / 60 回)
 *   2. Tenant 取得 + plan 解決
 *   3. Beginner プランの月間呼び出し回数上限チェック
 *   4. monthlyBudgetCapJpy 設定時の予測コスト超過チェック
 *   5. 実 LLM 呼び出し (caller の callback)
 *   6. 成功時に Tenant.currentMonthApiCallCount/CostJpy をアトミック increment
 *      + ApiCallLog 記録
 *
 * 縮退モード (LLM 呼び出しを行わず即返却):
 *   - rate_limited: 短期 rate limit 超過
 *   - tenant_inactive: Tenant 削除済 (deletedAt != null) または存在しない
 *   - beginner_limit_exceeded: Beginner 月間 100 回 (default) 超過
 *   - budget_exceeded: ユーザ自己設定の monthlyBudgetCapJpy 超過予測
 *
 * 失敗モード (LLM 呼び出しが投げた場合):
 *   - llm_error: 内部例外。caller 側でフォールバック (既存スコアリング等) する想定。
 *     **失敗時はカウンタを進めない** ため、ユーザは料金を課されない。
 *
 * 設計判断:
 *   - userId は optional (undefined = cron / システム実行)。userId なし時は
 *     rate limit をスキップ (admin 責任で別途制御)。
 *   - 予測コストは options.predictedCostJpy で上書き可能 (embedding 等で
 *     per-call 価格と差がある特殊ケース用)。デフォルトは plan 単価。
 *   - increment と ApiCallLog 記録は単一 transaction で実行 (整合性担保)。
 *     transaction 失敗は内部エラーとして throw — caller がエラー処理。
 *
 * 関連:
 *   - 設計: docs/design/SUGGESTION_ENGINE.md
 *   - 計画: docs/roadmap/SUGGESTION_ENGINE_PLAN.md PR #2
 *   - 配下: src/lib/llm/rate-limiter.ts
 *   - 設定: src/config/llm.ts
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import {
  LLM_RATE_LIMIT,
  resolveCostForPlan,
  resolveModelForPlan,
} from '@/config/llm';
import { isTenantPlan, type TenantPlan } from '@/lib/tenant';
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
    | 'plan_invalid';
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
  const costJpy = resolveCostForPlan(plan, {
    pricePerCallHaiku: tenant.pricePerCallHaiku,
    pricePerCallSonnet: tenant.pricePerCallSonnet,
  });

  // ---------- Step 3: Beginner プラン月間上限チェック ----------
  if (plan === 'beginner') {
    if (tenant.currentMonthApiCallCount >= tenant.beginnerMonthlyCallLimit) {
      return {
        ok: false,
        reason: 'beginner_limit_exceeded',
        message: `Beginner プランの月間 ${tenant.beginnerMonthlyCallLimit} 回上限に達しました`,
      };
    }
  }

  // ---------- Step 4: monthlyBudgetCapJpy 予測超過チェック ----------
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

  // ---------- Step 6: アトミック increment + ApiCallLog 記録 ----------
  await prisma.$transaction([
    prisma.tenant.update({
      where: { id: options.tenantId },
      data: {
        currentMonthApiCallCount: { increment: 1 },
        currentMonthApiCostJpy: { increment: costJpy },
      },
    }),
    prisma.apiCallLog.create({
      data: {
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
  ]);

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
