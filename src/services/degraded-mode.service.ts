/**
 * 縮退モード判定サービス (Q5(3) UI 可視化 / 2026-05-14)
 *
 * 役割:
 *   テナントの月間 API 呼出 / 課金カウンタと plan / 月額予算上限から、現時点で
 *   embedding 等の LLM 呼出が縮退状態に入っているかを判定する。
 *   テナント設定画面の「縮退モード起動中」バナー + 全般ユーザ向け banner で参照する。
 *
 * 判定ロジック (withMeteredLLM の Step 3 + 4 と整合):
 *   - Beginner: `currentMonthApiCallCount >= beginnerMonthlyCallLimit`
 *     ※ ADR-0019 (2026-05-24) 以降、`currentMonthApiCallCount` は課金対象 featureUnit
 *       (= BILLABLE_FEATURE_UNITS) のみで increment される。よって本判定は自動的に
 *       「課金対象 call が月 50 件 (default) に達したら縮退」を意味する。
 *       無料 featureUnit (chat / asset embedding 等) は本上限を消費せず継続実行可能。
 *   - Expert / Pro: monthlyBudgetCapJpy が設定済なら
 *     `currentMonthApiCostJpy >= monthlyBudgetCapJpy`
 *     未設定 (NULL) の Pro/Expert は無制限なので縮退しない
 *
 * 関連:
 *   - 設計: docs/business/TENANT_AND_BILLING.md §34.14.4
 *   - UI: src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx
 *   - banner: src/components/degraded-mode-banner.tsx
 */

import { prisma } from '@/lib/db';
import {
  countNullEmbeddings,
  type NullEmbeddingCounts,
} from './embedding-backfill.service';

export interface DegradedModeState {
  /** 現時点で API 呼出が停止しているか */
  active: boolean;
  /** active=true のときの理由 */
  reason: 'beginner_limit_exceeded' | 'budget_exceeded' | null;
  /** 当月の API 呼出回数 (= Tenant.currentMonthApiCallCount) */
  currentMonthApiCallCount: number;
  /** 当月の API 課金額 (Beginner は常に 0) */
  currentMonthApiCostJpy: number;
  /** Beginner プラン月間上限 (Beginner のみ参照) */
  beginnerMonthlyCallLimit: number | null;
  /** Pro/Expert の月額予算上限 (NULL=無制限) */
  monthlyBudgetCapJpy: number | null;
  /** plan 名 */
  plan: 'beginner' | 'expert' | 'pro' | string;
  /** embedding=NULL のエンティティ件数 (内訳付き) */
  nullEmbeddings: NullEmbeddingCounts;
}

/**
 * テナントの縮退モード状態を取得する。
 */
export async function getDegradedModeState(
  tenantId: string,
): Promise<DegradedModeState | null> {
  const t = await prisma.tenant.findFirst({
    where: { id: tenantId, deletedAt: null },
    select: {
      plan: true,
      currentMonthApiCallCount: true,
      currentMonthApiCostJpy: true,
      beginnerMonthlyCallLimit: true,
      monthlyBudgetCapJpy: true,
    },
  });
  if (!t) return null;

  let active = false;
  let reason: DegradedModeState['reason'] = null;

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

  const nullEmbeddings = await countNullEmbeddings(tenantId);

  return {
    active,
    reason,
    currentMonthApiCallCount: t.currentMonthApiCallCount,
    currentMonthApiCostJpy: t.currentMonthApiCostJpy,
    beginnerMonthlyCallLimit:
      t.plan === 'beginner' ? t.beginnerMonthlyCallLimit : null,
    monthlyBudgetCapJpy: t.monthlyBudgetCapJpy,
    plan: t.plan,
    nullEmbeddings,
  };
}
