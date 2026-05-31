/**
 * 縮退モード判定サービス (Q5(3) UI 可視化 / 2026-05-14)
 *
 * 役割:
 *   テナントの月間 API 呼出 / 課金カウンタと plan / 月額予算上限から、現時点で
 *   embedding 等の LLM 呼出が縮退状態に入っているかを判定する。
 *   テナント設定画面の「縮退モード起動中」バナー + 全般ユーザ向け banner で参照する。
 *
 * 判定ロジック (withMeteredLLM の Step 3 + 3.1 + 4 + 4.1 と整合):
 *   - Beginner LLM: `currentMonthApiCallCount >= beginnerMonthlyCallLimit`
 *     ※ ADR-0019 以降、`currentMonthApiCallCount` は LLM_BILLABLE のみで increment。
 *   - Beginner Embedding (ADR-0030 / 2026-05-30):
 *     `currentMonthEmbeddingCallCount >= BEGINNER_EMBEDDING_MONTHLY_LIMIT (= 100)`
 *     超過時は新規 embedding 生成のみ停止、既存 embedding 検索は継続、月初 backfill で次月補填。
 *   - Expert / Pro LLM: monthlyBudgetCapJpy が設定済なら
 *     `currentMonthApiCostJpy >= monthlyBudgetCapJpy`
 *   - Expert / Pro Embedding (ADR-0030): monthlyEmbeddingBudgetCapJpy が設定済なら
 *     `currentMonthEmbeddingCostJpy >= monthlyEmbeddingBudgetCapJpy`
 *     未設定 (NULL) は無制限なので縮退しない。
 *
 * 2 関数構成 (perf/dashboard-layout-parallel-ssr / 2026-06-01):
 *   - {@link getDegradedModeBannerState}: 全 dashboard layout で毎リクエスト呼ばれる軽量版。
 *     countNullEmbeddings (5 テーブル COUNT(*) UNION) を含まないため
 *     "Banner 表示判定だけが必要な layout 経路" で SSR レイテンシを削減する。
 *   - {@link getDegradedModeState}: 設定画面 (/settings/tenant) 用の詳細版。
 *     Banner state に embedding 未生成件数の内訳を加える。内部は Promise.all で
 *     Banner + countNullEmbeddings を並列実行するため設定画面側でも体感速度が向上する。
 *
 * 関連:
 *   - 設計: docs/business/TENANT_AND_BILLING.md §34.14.4
 *   - UI: src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx
 *   - banner: src/components/degraded-mode-banner.tsx
 *   - layout: src/app/(dashboard)/layout.tsx
 */

import { prisma } from '@/lib/db';
import {
  countNullEmbeddings,
  type NullEmbeddingCounts,
} from './embedding-backfill.service';
import { BEGINNER_EMBEDDING_MONTHLY_LIMIT } from '@/config/embedding-pricing';

/**
 * Banner 表示判定に必要な情報のみを含む軽量 state。
 * countNullEmbeddings 集計を含まないため dashboard layout で毎リクエスト呼んでも軽い。
 */
export interface DegradedModeBannerState {
  /** 現時点で API 呼出が停止しているか */
  active: boolean;
  /**
   * active=true のときの理由。ADR-0030 (2026-05-30) で Embedding 系 2 reason 追加。
   * - beginner_limit_exceeded: Beginner LLM 50 件 (ADR-0019)
   * - budget_exceeded: Expert/Pro LLM 月次予算上限 (ADR-0019)
   * - embedding_beginner_limit_exceeded: Beginner Embedding 100 件 (ADR-0030)
   * - embedding_budget_exceeded: Expert/Pro Embedding 月次予算上限 (ADR-0030)
   */
  reason:
    | 'beginner_limit_exceeded'
    | 'budget_exceeded'
    | 'embedding_beginner_limit_exceeded'
    | 'embedding_budget_exceeded'
    | null;
  /** 当月の API 呼出回数 (= Tenant.currentMonthApiCallCount) */
  currentMonthApiCallCount: number;
  /** 当月の API 課金額 (Beginner は常に 0) */
  currentMonthApiCostJpy: number;
  /** ADR-0030: 当月の Embedding 呼出回数 (= Tenant.currentMonthEmbeddingCallCount) */
  currentMonthEmbeddingCallCount: number;
  /** ADR-0030: 当月の Embedding 課金額 (Beginner は常に 0) */
  currentMonthEmbeddingCostJpy: number;
  /** Beginner プラン月間上限 (Beginner のみ参照) */
  beginnerMonthlyCallLimit: number | null;
  /** ADR-0030: Beginner Embedding 月間上限 (Beginner のみ参照) */
  beginnerEmbeddingMonthlyLimit: number | null;
  /** Pro/Expert の月額予算上限 (NULL=無制限) */
  monthlyBudgetCapJpy: number | null;
  /** ADR-0030: Pro/Expert の Embedding 月額予算上限 (NULL=無制限) */
  monthlyEmbeddingBudgetCapJpy: number | null;
  /** plan 名 */
  plan: 'beginner' | 'expert' | 'pro' | string;
}

/**
 * 設定画面 (/settings/tenant) 向けの詳細 state。
 * Banner state に embedding 未生成件数の内訳を加える。
 */
export interface DegradedModeState extends DegradedModeBannerState {
  /** embedding=NULL のエンティティ件数 (内訳付き) */
  nullEmbeddings: NullEmbeddingCounts;
}

/**
 * Banner 判定のみが必要な経路 (dashboard layout) 向けの軽量取得関数。
 *
 * dashboard 配下の全画面で毎リクエスト呼ばれるため、countNullEmbeddings は実行しない。
 * Banner 表示判定に必要な active / reason + 関連集計値のみを返す。
 */
export async function getDegradedModeBannerState(
  tenantId: string,
): Promise<DegradedModeBannerState | null> {
  const t = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      plan: true,
      currentMonthApiCallCount: true,
      currentMonthApiCostJpy: true,
      currentMonthEmbeddingCallCount: true,
      currentMonthEmbeddingCostJpy: true,
      beginnerMonthlyCallLimit: true,
      monthlyBudgetCapJpy: true,
      monthlyEmbeddingBudgetCapJpy: true,
    },
  });
  if (!t) return null;

  let active = false;
  let reason: DegradedModeBannerState['reason'] = null;

  // LLM 経路の縮退判定 (既存)
  if (t.plan === 'beginner') {
    if (t.currentMonthApiCallCount >= t.beginnerMonthlyCallLimit) {
      active = true;
      reason = 'beginner_limit_exceeded';
    }
  } else if (t.monthlyBudgetCapJpy != null) {
    if (t.currentMonthApiCostJpy >= t.monthlyBudgetCapJpy) {
      active = true;
      reason = 'budget_exceeded';
    }
  }

  // ADR-0030 (2026-05-30): Embedding 経路の縮退判定。
  //   既に LLM 経路で縮退中なら reason は LLM 側を優先 (= ユーザの行動次第で先に到達した方を示す)。
  //   LLM 経路で active=false の場合のみ Embedding 経路を評価する。
  //   到達時は新規 embedding 生成のみ停止、既存 embedding 検索は継続、月初 backfill で次月補填。
  if (!active) {
    if (t.plan === 'beginner') {
      if (t.currentMonthEmbeddingCallCount >= BEGINNER_EMBEDDING_MONTHLY_LIMIT) {
        active = true;
        reason = 'embedding_beginner_limit_exceeded';
      }
    } else if (t.monthlyEmbeddingBudgetCapJpy != null) {
      if (t.currentMonthEmbeddingCostJpy >= t.monthlyEmbeddingBudgetCapJpy) {
        active = true;
        reason = 'embedding_budget_exceeded';
      }
    }
  }

  return {
    active,
    reason,
    currentMonthApiCallCount: t.currentMonthApiCallCount,
    currentMonthApiCostJpy: t.currentMonthApiCostJpy,
    currentMonthEmbeddingCallCount: t.currentMonthEmbeddingCallCount,
    currentMonthEmbeddingCostJpy: t.currentMonthEmbeddingCostJpy,
    beginnerMonthlyCallLimit:
      t.plan === 'beginner' ? t.beginnerMonthlyCallLimit : null,
    beginnerEmbeddingMonthlyLimit:
      t.plan === 'beginner' ? BEGINNER_EMBEDDING_MONTHLY_LIMIT : null,
    monthlyBudgetCapJpy: t.monthlyBudgetCapJpy,
    monthlyEmbeddingBudgetCapJpy: t.monthlyEmbeddingBudgetCapJpy,
    plan: t.plan,
  };
}

/**
 * テナントの縮退モード状態 (詳細版) を取得する。
 *
 * 設定画面 (/settings/tenant) 用。Banner state + embedding 未生成件数の内訳を返す。
 * Banner 判定と countNullEmbeddings (5 テーブル COUNT(*) UNION) を Promise.all で並列実行する。
 */
export async function getDegradedModeState(
  tenantId: string,
): Promise<DegradedModeState | null> {
  const [banner, nullEmbeddings] = await Promise.all([
    getDegradedModeBannerState(tenantId),
    countNullEmbeddings(tenantId),
  ]);
  if (!banner) return null;
  return { ...banner, nullEmbeddings };
}
