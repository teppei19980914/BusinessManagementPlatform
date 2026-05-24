/**
 * Fair Use Limit サービス (ADR-0019 / 2026-05-24)
 *
 * 役割:
 *   無料化された featureUnit (= `!isBillableFeatureUnit(featureUnit)`) に対する
 *   tenant-level 月次上限を実装する。
 *
 *   ADR-0019 で「資産作成/更新」「チャット検索」「embedding-backfill cron」「CSV インポート」を
 *   全プラン無料化したことに伴い、これらは `monthlyBudgetCapJpy` (predicted cost 0) や
 *   `beginnerMonthlyCallLimit` で防御できなくなった。一方で Voyage 200M 無料枠は全テナント
 *   共有のため、1 テナントの暴走 (DoS / 経済的攻撃) が全社に波及するリスクがある。
 *
 *   本サービスは tenant 単位で「無料 featureUnit の月次 call 数」を集計し、閾値を超過したら
 *   `withMeteredLLM` を縮退モード (`reason: 'fair_use_limit_exceeded'`) で返却させる。
 *
 * 設計判断:
 *   - **閾値** (ADR-0019 §LLM 暴走防止):
 *       - Warning: 月 **8,000 calls/tenant** で super_admin 通知 (アラート系は別途)
 *       - Hard: 月 **10,000 calls/tenant** で当該テナントの無料 featureUnit を縮退モード
 *     これらは推奨デフォルト値で、3-6 ヶ月の実運用データを見て再評価する (ADR-0019 §未確定事項)。
 *   - **billable featureUnit には適用しない**: 課金対象は plan 単価 × budget cap で自然に
 *     防御されるため、本上限は無料 call 専用。
 *   - **ApiCallLog ベースで集計**: counter (currentMonthApiCallCount) は billable のみ進むため、
 *     無料 call 数は ApiCallLog から `featureUnit NOT IN BILLABLE_FEATURE_UNITS` で集計する。
 *   - **月境界はテナント TZ**: tenant-monthly-reset / api-usage-recalc と同じ境界を使う。
 *   - **キャッシュなし**: 1 call ごとに DB 集計を走らせる。月内最大 10,000 call なら DB 負荷は許容範囲。
 *     パフォーマンス問題が発覚したら counter フィールド追加で最適化検討。
 *
 * 関連:
 *   - ADR: docs/adr/0019-billable-feature-units-and-free-tier-expansion.md §LLM 暴走防止
 *   - 統合先: src/lib/llm/metered.ts (Step 3.5 で本関数を呼ぶ)
 *   - 課金分類: src/config/billing-feature-units.ts (BILLABLE_FEATURE_UNITS)
 *   - Voyage 全社監視 (別軸): src/services/usage-monitoring.service.ts
 */

import { prisma } from '@/lib/db';
import { BILLABLE_FEATURE_UNITS } from '@/config/billing-feature-units';
import { getTenantMonthStart } from '@/lib/tenant-time';
import { DEFAULT_TIMEZONE } from '@/config/i18n';

/**
 * Fair use limit の閾値 (ADR-0019 / 2026-05-24)。
 *
 * 単位: 1 テナントあたりの月間無料 featureUnit 呼出回数。
 *
 * 数値根拠 (ADR-0019 §LLM 暴走防止):
 *   - 通常利用想定 (テナント月): asset 50 + chat 100 + backfill 数十 = ~200 calls/月
 *   - ヘビー利用想定 (ADR-0019 §収益影響): asset 1000 + chat 10000 = 11,000 calls/月
 *   - 異常利用 (= 攻撃 / バグ): 月数万〜数十万 calls
 *   - 8,000 は「ヘビー利用の手前で警告を出す」値、10,000 は「ヘビー利用の上限手前で停止」値。
 */
export const FAIR_USE_LIMIT = {
  /** 月 N call 到達で super_admin 通知 (まだ縮退モードには入らない) */
  WARNING: 8_000,
  /** 月 N call 到達で当該テナントの無料 featureUnit を縮退モード (= LLM 呼出停止) */
  HARD: 10_000,
} as const;

/**
 * `checkFairUseLimit` の結果。
 *
 * - `allowed=true`: 呼出を継続して OK。`usedCount` は現在の月間消費数 (情報目的)。
 * - `allowed=false`: 縮退モード。`reason='fair_use_limit_exceeded'` で停止。
 */
export type FairUseLimitCheckResult =
  | {
      allowed: true;
      usedCount: number;
      warningExceeded: boolean; // 警告閾値超え (8,000+) を通知用に伝える
    }
  | {
      allowed: false;
      reason: 'fair_use_limit_exceeded';
      usedCount: number;
      hardLimit: number;
      message: string;
    };

/**
 * 指定テナントの無料 featureUnit 月次消費数を集計し、Fair use limit に対する状態を返す。
 *
 * 呼出側 (= withMeteredLLM Step 3.5):
 *   - billable featureUnit の呼出時は本関数を呼ばない (= 既存の Beginner 上限 / budget cap で防御)
 *   - 無料 featureUnit の呼出時のみ本関数を呼び、allowed=false なら縮退モードで早期 return
 *
 * @param tenantId 対象テナント
 * @param tenantTimezone テナント TZ (月境界の計算用、null なら DEFAULT_TIMEZONE)
 * @param now 検証時刻 (デフォルト現在、テスト時に上書き)
 */
export async function checkFairUseLimit(
  tenantId: string,
  tenantTimezone: string | null,
  now: Date = new Date(),
): Promise<FairUseLimitCheckResult> {
  const timezone = tenantTimezone ?? DEFAULT_TIMEZONE;
  const monthStart = getTenantMonthStart(now, timezone);

  // 無料 featureUnit の月間 call 数を集計。
  // 注意: COUNT のみで十分 (cost は無料のため 0 固定)。
  const usedCount = await prisma.apiCallLog.count({
    where: {
      tenantId,
      createdAt: { gte: monthStart },
      featureUnit: { notIn: [...BILLABLE_FEATURE_UNITS] },
    },
  });

  if (usedCount >= FAIR_USE_LIMIT.HARD) {
    return {
      allowed: false,
      reason: 'fair_use_limit_exceeded',
      usedCount,
      hardLimit: FAIR_USE_LIMIT.HARD,
      message: `無料機能の月間利用上限 (${FAIR_USE_LIMIT.HARD.toLocaleString()} 回) に達したため、本月末まで一部機能を停止しています。資産入力・チャット検索・自動インポートが影響を受けます。Pro プランへのアップグレードまたは翌月をお待ちください。`,
    };
  }

  return {
    allowed: true,
    usedCount,
    warningExceeded: usedCount >= FAIR_USE_LIMIT.WARNING,
  };
}

/**
 * 全テナントの fair use limit 状態をスナップショットする (super_admin 監視用)。
 *
 * cron / super_admin ダッシュボード遷移時に呼ばれることを想定。warning 閾値超過テナントを
 * 一覧表示するための軽量集計。
 */
export async function listFairUseUsage(now: Date = new Date()): Promise<
  Array<{
    tenantId: string;
    tenantName: string;
    usedCount: number;
    status: 'ok' | 'warning' | 'hard';
  }>
> {
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, timezone: true },
  });

  const results = await Promise.all(
    tenants.map(async (t) => {
      const check = await checkFairUseLimit(t.id, t.timezone, now);
      const status: 'ok' | 'warning' | 'hard' = !check.allowed
        ? 'hard'
        : check.warningExceeded
          ? 'warning'
          : 'ok';
      const usedCount = check.allowed ? check.usedCount : check.usedCount;
      return {
        tenantId: t.id,
        tenantName: t.name,
        usedCount,
        status,
      };
    }),
  );

  return results;
}
