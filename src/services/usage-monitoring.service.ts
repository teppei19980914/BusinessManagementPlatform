/**
 * 使用量監視・異常検知サービス (PR #7 / T-03 提案エンジン v2)
 *
 * 役割:
 *   1. **日次集計**: ApiCallLog をテナント別・日次で集計し、利用状況を把握
 *   2. **異常検知**: ローリング平均から突発的な spike (5x+) を検出
 *   3. **予算アラート判定**: 月次予算の 80%/100%/150% 到達テナントを列挙
 *   4. **admin 用サマリ**: 全テナント横断の使用量を JSON で返す (super_admin ダッシュボード基盤)
 *
 * 設計判断:
 *   - 集計用のサマリテーブルを **追加しない**: ApiCallLog からオンデマンド集計。
 *     v1 規模 (5-50 テナント) では負荷的に問題なく、schema 簡素化を優先。
 *     将来テナント数 1000+ で性能問題が出たら別 PR で daily_usage_summaries を追加検討。
 *   - **異常検知の閾値**: 過去 7 日のローリング平均の **5 倍** を spike とみなす。
 *     - 3σ 統計検定は十分なサンプル数が必要 (本サービス初期はテナント当たり 7 日 × 数件で
 *       統計的に脆弱)。シンプルな倍率閾値の方がチューニングしやすい。
 *     - 5x は経験則: 通常運用の自然な揺れ (週末効果、月末スパイク) を許容しつつ、
 *       明らかな異常 (バグ・攻撃) のみを拾う。
 *
 * **2026-05-14 (縮退モード仕様確定)**: メール通知を廃止。
 *   旧仕様では `notifyAdminsOfAlerts` が systemRole='admin' に対して使用量アラートを
 *   メール送信していたが、admin ダッシュボード (`/api/admin/usage-summary`) で同じ情報を
 *   随時参照できるため二重通知の必要なし。メール送信単価が上限超過/縮退の意味付けと
 *   矛盾するため (= 課金を抑える縮退モード起動下で別経路の出費を増やさない) 廃止する。
 *
 * 関連:
 *   - 計画: docs/roadmap/SUGGESTION_ENGINE_PLAN.md PR #7
 *   - 設計: docs/design/SUGGESTION_ENGINE.md §コスト超過リスクと監視ポイント
 *   - エントリポイント: src/app/api/cron/daily-usage-aggregation/route.ts (外部 cron (cron-job.org))
 *   - admin API: src/app/api/admin/usage-summary/route.ts
 */

import { prisma } from '@/lib/db';

// ================================================================
// 公開型
// ================================================================

export interface DailyUsageRow {
  tenantId: string;
  tenantName: string;
  /** 当日 (UTC 00:00 〜 翌 00:00) の API 呼び出し件数 */
  callCount: number;
  /** 当日の合計課金額 (円) */
  costJpy: number;
  /** Voyage 入力トークン合計 (embedding 生成) */
  embeddingTokens: number;
  /** Anthropic 入力トークン合計 */
  llmInputTokens: number;
  /** Anthropic 出力トークン合計 */
  llmOutputTokens: number;
}

export interface Anomaly {
  tenantId: string;
  tenantName: string;
  /** 当日呼び出し件数 */
  todayCalls: number;
  /** 過去 7 日のローリング平均呼び出し件数 */
  rollingAvg7d: number;
  /** spike 倍率 (todayCalls / rollingAvg7d) */
  multiplier: number;
}

export interface BudgetAlert {
  tenantId: string;
  tenantName: string;
  /**
   * 予算種別。ADR-0030 (2026-05-30) で `embedding` を追加。
   * - llm: 月次予算上限 (LLM = project-upsert / suggestion-explanation / auto-tag-extract)
   * - embedding: Embedding 月次予算上限 (EMBEDDING_BILLABLE_FEATURE_UNITS 7 種)
   */
  kind: 'llm' | 'embedding';
  /** 当月累積課金額 */
  currentMonthCostJpy: number;
  /** 月次予算上限 (円) */
  monthlyBudgetCapJpy: number;
  /** 予算消化率 (0.0 - 1.0+) */
  utilizationRate: number;
  /** 通知レベル: 80%・100%・150% (オーバー) */
  level: 'warning_80' | 'critical_100' | 'overage_150';
}

export interface AdminUsageSummary {
  /** 集計対象日 (YYYY-MM-DD UTC) */
  date: string;
  /** テナント別 日次サマリ */
  tenants: DailyUsageRow[];
  /** 全テナント合計 */
  total: {
    tenantCount: number;
    callCount: number;
    costJpy: number;
    embeddingTokens: number;
    llmInputTokens: number;
    llmOutputTokens: number;
  };
  /** 検出された異常 */
  anomalies: Anomaly[];
  /** 検出された予算アラート */
  budgetAlerts: BudgetAlert[];
}

// ================================================================
// 定数
// ================================================================

/** 異常検知の倍率閾値: 7 日平均の N 倍を spike とみなす */
const ANOMALY_MULTIPLIER_THRESHOLD = 5;
/** ローリング平均の窓幅 (日数) */
const ROLLING_WINDOW_DAYS = 7;
/** ローリング平均が小さすぎると倍率が暴走するため、最小ベースライン (件数) */
const MIN_ROLLING_AVG_FOR_DETECTION = 5;
/** 予算アラートの閾値 */
const BUDGET_THRESHOLDS = { warning: 0.8, critical: 1.0, overage: 1.5 } as const;

// ================================================================
// 内部ヘルパ: 日付境界
// ================================================================

/**
 * 指定日の UTC 0:00 〜 翌 UTC 0:00 の範囲を返す。
 * `date` は任意の時刻でも、その日の UTC 00:00 から始まる範囲に正規化される。
 */
function dayBoundsUTC(date: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0, 0, 0, 0,
  ));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

// ================================================================
// 公開関数: 日次集計
// ================================================================

/**
 * 指定日 (UTC) の ApiCallLog をテナント別に集計する。
 *
 * @param date 集計対象日 (UTC ベース、時刻無視)
 * @returns テナント別の日次集計行 (deletedAt=null の有効テナントのみ)
 */
export async function getDailyUsageByTenant(date: Date): Promise<DailyUsageRow[]> {
  const { start, end } = dayBoundsUTC(date);

  // GROUP BY tenant_id で集計。Prisma では groupBy がサポートされているが、
  // 関連テーブル (Tenant.name) を JOIN したいので raw SQL を使う。
  type Row = {
    tenant_id: string;
    tenant_name: string;
    call_count: bigint;
    cost_jpy: bigint;
    embedding_tokens: bigint | null;
    llm_input_tokens: bigint | null;
    llm_output_tokens: bigint | null;
  };
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT
      l.tenant_id::text                                AS tenant_id,
      t.name                                            AS tenant_name,
      COUNT(*)::bigint                                  AS call_count,
      COALESCE(SUM(l.cost_jpy), 0)::bigint              AS cost_jpy,
      COALESCE(SUM(l.embedding_tokens), 0)::bigint      AS embedding_tokens,
      COALESCE(SUM(l.llm_input_tokens), 0)::bigint      AS llm_input_tokens,
      COALESCE(SUM(l.llm_output_tokens), 0)::bigint     AS llm_output_tokens
    FROM "api_call_logs" l
    INNER JOIN "tenants" t ON t.id = l.tenant_id AND t.deleted_at IS NULL
    WHERE l.created_at >= ${start}
      AND l.created_at < ${end}
    GROUP BY l.tenant_id, t.name
    ORDER BY call_count DESC
  `;

  return rows.map((r) => ({
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    callCount: Number(r.call_count),
    costJpy: Number(r.cost_jpy),
    embeddingTokens: Number(r.embedding_tokens ?? 0),
    llmInputTokens: Number(r.llm_input_tokens ?? 0),
    llmOutputTokens: Number(r.llm_output_tokens ?? 0),
  }));
}

// ================================================================
// 公開関数: 異常検知
// ================================================================

/**
 * 過去 N 日 (デフォルト 7 日) のテナント別ローリング平均を取得する。
 *
 * @param endExclusive 集計範囲の終端 (この日付は含まない)
 * @param days ローリング窓幅
 */
async function getRollingAvgCallsByTenant(
  endExclusive: Date,
  days: number,
): Promise<Map<string, number>> {
  const start = new Date(endExclusive.getTime() - days * 24 * 60 * 60 * 1000);

  type Row = { tenant_id: string; avg_calls: number };
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT
      tenant_id::text AS tenant_id,
      (COUNT(*)::float / ${days}::float) AS avg_calls
    FROM "api_call_logs"
    WHERE created_at >= ${start}
      AND created_at < ${endExclusive}
    GROUP BY tenant_id
  `;

  const m = new Map<string, number>();
  for (const r of rows) m.set(r.tenant_id, Number(r.avg_calls));
  return m;
}

/**
 * 指定日のテナント別呼び出し件数が、過去 7 日のローリング平均の N 倍 (デフォルト 5x)
 * を超える「異常スパイク」を検出する。
 *
 * 統計的妥当性のため、ローリング平均が小さすぎる (< MIN_ROLLING_AVG_FOR_DETECTION)
 * テナントは検知対象外 (=新規テナントの初動を異常と誤検知しない)。
 */
export async function detectAnomalies(date: Date): Promise<Anomaly[]> {
  const today = await getDailyUsageByTenant(date);
  const { start: dayStart } = dayBoundsUTC(date);
  const rollingAvg = await getRollingAvgCallsByTenant(dayStart, ROLLING_WINDOW_DAYS);

  const anomalies: Anomaly[] = [];
  for (const t of today) {
    const avg = rollingAvg.get(t.tenantId) ?? 0;
    if (avg < MIN_ROLLING_AVG_FOR_DETECTION) continue; // 新規テナント等は検知対象外

    const multiplier = t.callCount / avg;
    if (multiplier >= ANOMALY_MULTIPLIER_THRESHOLD) {
      anomalies.push({
        tenantId: t.tenantId,
        tenantName: t.tenantName,
        todayCalls: t.callCount,
        rollingAvg7d: Math.round(avg * 100) / 100,
        multiplier: Math.round(multiplier * 100) / 100,
      });
    }
  }
  return anomalies;
}

// ================================================================
// 公開関数: 予算アラート
// ================================================================

/**
 * 月次予算上限を設定しているテナントについて、当月累積コストが閾値 (80% / 100% / 150%) を
 * 超えていればアラート行を返す。閾値未到達・予算未設定 (NULL) のテナントは無視。
 *
 * ADR-0030 (2026-05-30): LLM 用 (`monthlyBudgetCapJpy`) と Embedding 用 (`monthlyEmbeddingBudgetCapJpy`)
 * の **2 軸** を独立に判定し、それぞれを `kind` フィールドで区別したアラートを返す。
 * 1 つのテナントが両軸で閾値超過した場合は 2 件のアラートが返る。
 */
export async function detectBudgetAlerts(): Promise<BudgetAlert[]> {
  const tenants = await prisma.tenant.findMany({
    where: {
      deletedAt: null,
      // LLM 用 OR Embedding 用のいずれかが設定済のテナント
      OR: [
        { monthlyBudgetCapJpy: { not: null } },
        { monthlyEmbeddingBudgetCapJpy: { not: null } },
      ],
    },
    select: {
      id: true,
      name: true,
      currentMonthApiCostJpy: true,
      currentMonthEmbeddingCostJpy: true,
      monthlyBudgetCapJpy: true,
      monthlyEmbeddingBudgetCapJpy: true,
    },
  });

  const alerts: BudgetAlert[] = [];
  for (const t of tenants) {
    // LLM 軸の判定
    if (t.monthlyBudgetCapJpy && t.monthlyBudgetCapJpy > 0) {
      const rate = t.currentMonthApiCostJpy / t.monthlyBudgetCapJpy;
      let level: BudgetAlert['level'] | null = null;
      if (rate >= BUDGET_THRESHOLDS.overage) level = 'overage_150';
      else if (rate >= BUDGET_THRESHOLDS.critical) level = 'critical_100';
      else if (rate >= BUDGET_THRESHOLDS.warning) level = 'warning_80';
      if (level) {
        alerts.push({
          tenantId: t.id,
          tenantName: t.name,
          kind: 'llm',
          currentMonthCostJpy: t.currentMonthApiCostJpy,
          monthlyBudgetCapJpy: t.monthlyBudgetCapJpy,
          utilizationRate: Math.round(rate * 1000) / 1000,
          level,
        });
      }
    }

    // ADR-0030 (2026-05-30): Embedding 軸の判定 (LLM とは独立に評価)
    if (t.monthlyEmbeddingBudgetCapJpy && t.monthlyEmbeddingBudgetCapJpy > 0) {
      const rate = t.currentMonthEmbeddingCostJpy / t.monthlyEmbeddingBudgetCapJpy;
      let level: BudgetAlert['level'] | null = null;
      if (rate >= BUDGET_THRESHOLDS.overage) level = 'overage_150';
      else if (rate >= BUDGET_THRESHOLDS.critical) level = 'critical_100';
      else if (rate >= BUDGET_THRESHOLDS.warning) level = 'warning_80';
      if (level) {
        alerts.push({
          tenantId: t.id,
          tenantName: t.name,
          kind: 'embedding',
          currentMonthCostJpy: t.currentMonthEmbeddingCostJpy,
          monthlyBudgetCapJpy: t.monthlyEmbeddingBudgetCapJpy,
          utilizationRate: Math.round(rate * 1000) / 1000,
          level,
        });
      }
    }
  }
  return alerts;
}

// ================================================================
// 公開関数: admin 用ダッシュボード JSON
// ================================================================

/**
 * 全テナント横断の使用量サマリを返す (admin/super_admin 用)。
 *
 * @param date 集計対象日 (省略時は本日 UTC)
 */
export async function getAdminUsageSummary(date?: Date): Promise<AdminUsageSummary> {
  const targetDate = date ?? new Date();
  const tenants = await getDailyUsageByTenant(targetDate);
  const anomalies = await detectAnomalies(targetDate);
  const budgetAlerts = await detectBudgetAlerts();

  const total = tenants.reduce(
    (acc, t) => ({
      tenantCount: acc.tenantCount + 1,
      callCount: acc.callCount + t.callCount,
      costJpy: acc.costJpy + t.costJpy,
      embeddingTokens: acc.embeddingTokens + t.embeddingTokens,
      llmInputTokens: acc.llmInputTokens + t.llmInputTokens,
      llmOutputTokens: acc.llmOutputTokens + t.llmOutputTokens,
    }),
    { tenantCount: 0, callCount: 0, costJpy: 0, embeddingTokens: 0, llmInputTokens: 0, llmOutputTokens: 0 },
  );

  return {
    date: targetDate.toISOString().split('T')[0],
    tenants,
    total,
    anomalies,
    budgetAlerts,
  };
}

// ================================================================
// 公開関数: Cron エントリポイント (まとめ実行)
// ================================================================

/**
 * 日次集計バッチの本体。外部 cron (cron-job.org) から呼ばれる。
 *
 * 1. 昨日 (UTC) の使用量を集計
 * 2. 異常検知
 * 3. 予算アラート判定
 *
 * **2026-05-14**: メール通知は廃止 (admin ダッシュボードで随時参照可能)。
 * 集計と検知の結果は返却値で把握できるため、本関数の責務は集計の実施のみ。
 *
 * @returns 実行結果サマリ
 */
export async function runDailyUsageAggregation(): Promise<{
  date: string;
  tenantCount: number;
  totalCalls: number;
  totalCostJpy: number;
  anomalyCount: number;
  budgetAlertCount: number;
}> {
  // 集計対象は「実行時点の昨日 UTC」
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const summary = await getAdminUsageSummary(yesterday);

  return {
    date: summary.date,
    tenantCount: summary.total.tenantCount,
    totalCalls: summary.total.callCount,
    totalCostJpy: summary.total.costJpy,
    anomalyCount: summary.anomalies.length,
    budgetAlertCount: summary.budgetAlerts.length,
  };
}
