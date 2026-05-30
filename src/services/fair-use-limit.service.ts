/**
 * Fair Use Limit サービス (ADR-0019 / 2026-05-24 → ADR-0022 で Beginner 専用に縮小 / 2026-06-01
 *  → ADR-0030 で safety net に位置付け変更 / 2026-05-30)
 *
 * 役割 (ADR-0030 後の最終位置付け):
 *   **Beginner プラン × EMBEDDING_BILLABLE featureUnit** に対する tenant-level 月次上限 (10,000 件)
 *   = Voyage 200M 無料枠保護の **safety net**。
 *
 *   ADR-0030 (2026-05-30) で Beginner Embedding に明示的な試用上限 (100 件、BEGINNER_EMBEDDING_MONTHLY_LIMIT)
 *   が新設されたため、通常運用では Beginner 100 件が先に発火し本 Fair Use Limit (10,000 件) は到達しなくなった。
 *   本サービスは、Beginner 100 件チェック (metered.ts Step 3.1) を bypass するコードバグへの最終防御線
 *   として残置する。Voyage 無料枠 200M トークン (全テナント共有) を 1 テナントが意図せず食い潰さない
 *   ためのインフラ安全弁。
 *
 *   ADR-0019 で Embedding 系を全プラン無料化したことに伴い、無料 featureUnit 全般に対して
 *   Voyage 200M 無料枠保護のための月次 10,000 calls/tenant 上限を設けていた。
 *
 *   ADR-0022 (2026-06-01) で Expert/Pro の Embedding を課金化 (ADR-0029 で ¥5/call) したことに伴い、
 *   Expert/Pro は monthlyBudgetCap で自然防御されるため Fair Use Limit の対象から外した。
 *   Beginner は依然として Embedding が cost=0 のため防御手段がなく、本サービスを Beginner
 *   専用に縮小して継続維持する。
 *
 *   集計対象: Beginner プランのテナントが当月に呼び出した EMBEDDING_BILLABLE_FEATURE_UNITS
 *   (knowledge-embedding / risk-issue-embedding / retrospective-embedding / memo-embedding /
 *   chat-semantic-search / external-import-embedding / attachment-embedding) の合計回数。
 *   閾値超過時は `withMeteredLLM` を縮退モード (`reason: 'fair_use_limit_exceeded'`) で返却させる。
 *
 *   backfill (cron 自動リカバリ) はユーザ非起動のため対象外 (= 自動リカバリで上限に達して
 *   ユーザ操作が止まる事故を避ける)。
 *
 * 設計判断:
 *   - **閾値** (ADR-0019 §LLM 暴走防止、ADR-0022 で値は不変):
 *       - Warning: 月 **8,000 calls/tenant** で super_admin 通知 (利用継続可)
 *       - Hard: 月 **10,000 calls/tenant** で当該テナントの EMBEDDING_BILLABLE を縮退モード
 *     Beginner プランは 5 席 × 90 日試用期間内のため理論最大値 4,500,000 calls。これに対し
 *     10,000 calls/月の閾値で十分防御。
 *   - **Beginner 専用に縮小した理由**: Expert/Pro は ¥5/call 課金で (ADR-0029):
 *       * 経済的攻撃 (= Voyage 枠食い潰し DoS) は ¥5 × 10000 calls = ¥50,000 売上が立つため不成立
 *       * monthlyBudgetCap で自然防御される
 *     一方、Beginner は cost=0 + 5 席 + 90 日制限 + 同一メール再払出不可制約はあるが、
 *     試用期間内に Voyage 枠を集中的に消費される可能性が残るため上限を維持する。
 *   - **LLM_BILLABLE / Storage Overage / Backfill / 未知 は対象外**:
 *       * LLM は Beginner 50 件 / budget cap で別途防御済
 *       * Storage Overage は月初 cron なので本パスを通らない
 *       * Backfill は ユーザ非起動 (= 自動リカバリ) のため上限を消費しない設計
 *       * 未知は cost=0 で経路に乗らない
 *   - **ApiCallLog ベースで集計**: counter (currentMonthEmbeddingCallCount) は全プランで increment
 *     されるが、月境界が UTC vs テナント TZ で揺れる可能性があるため、ApiCallLog から直接 SUM
 *     する方が真値。月境界はテナント TZ ベース (= tenant-monthly-reset / api-usage-recalc と同じ)。
 *
 * 関連:
 *   - ADR: docs/adr/0019-billable-feature-units-and-free-tier-expansion.md §LLM 暴走防止
 *          docs/adr/0022-embedding-usage-based-billing.md §2.3
 *   - 統合先: src/lib/llm/metered.ts (Step 3.5 で本関数を呼ぶ、Beginner × Embedding 条件)
 *   - 課金分類: src/config/billing-feature-units.ts (EMBEDDING_BILLABLE_FEATURE_UNITS)
 *   - Voyage 全社監視 (別軸): src/services/usage-monitoring.service.ts
 */

import { prisma } from '@/lib/db';
import { EMBEDDING_BILLABLE_FEATURE_UNITS } from '@/config/billing-feature-units';
import { getTenantMonthStart } from '@/lib/tenant-time';
import { DEFAULT_TIMEZONE } from '@/config/i18n';

/**
 * Fair use limit の閾値 (ADR-0019 / 2026-05-24、ADR-0022 で Beginner 専用に縮小)。
 *
 * 単位: 1 Beginner テナントあたりの月間 EMBEDDING_BILLABLE 呼出回数。
 *
 * 数値根拠:
 *   - Beginner 通常利用想定: asset 50 + chat 100 + import 数十 = ~200 calls/月
 *   - Beginner ヘビー利用: asset 1000 + chat 10000 = 11,000 calls/月 (= 試用期間内であえて多用)
 *   - 異常利用 (= 攻撃 / バグ): 月数万〜数十万 calls
 *   - 8,000 は「ヘビー利用の手前で警告を出す」、10,000 は「ヘビー利用の上限手前で停止」。
 */
export const FAIR_USE_LIMIT = {
  /** 月 N call 到達で super_admin 通知 (まだ縮退モードには入らない) */
  WARNING: 8_000,
  /** 月 N call 到達で当該テナントの EMBEDDING_BILLABLE を縮退モード (= LLM 呼出停止) */
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
 * Beginner プランのテナントの EMBEDDING_BILLABLE 月次消費数を集計し、Fair use limit に対する状態を返す。
 *
 * 呼出側 (= withMeteredLLM Step 3.5):
 *   - plan === 'beginner' && isEmbeddingBillableFeatureUnit(featureUnit) のときのみ本関数を呼ぶ。
 *   - allowed=false なら縮退モードで早期 return。
 *
 * @param tenantId 対象テナント (Beginner プラン前提)
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

  // ADR-0022 (2026-06-01): EMBEDDING_BILLABLE のみ集計。
  //   LLM_BILLABLE は Beginner 50 件 / budget cap で別防御、Backfill は対象外、Storage Overage は
  //   本パスを通らない。「Voyage 200M 無料枠を食い潰すリスクのある操作」だけが対象。
  const usedCount = await prisma.apiCallLog.count({
    where: {
      tenantId,
      createdAt: { gte: monthStart },
      featureUnit: { in: [...EMBEDDING_BILLABLE_FEATURE_UNITS] },
    },
  });

  if (usedCount >= FAIR_USE_LIMIT.HARD) {
    return {
      allowed: false,
      reason: 'fair_use_limit_exceeded',
      usedCount,
      hardLimit: FAIR_USE_LIMIT.HARD,
      message: `Beginner プランの無料利用上限 (月 ${FAIR_USE_LIMIT.HARD.toLocaleString()} 回) に達したため、本月末まで一部機能を停止しています。資産入力・チャット検索・自動インポートが影響を受けます。Expert / Pro プランへのアップグレードまたは翌月をお待ちください。`,
    };
  }

  return {
    allowed: true,
    usedCount,
    warningExceeded: usedCount >= FAIR_USE_LIMIT.WARNING,
  };
}

/**
 * 全 Beginner テナントの fair use limit 状態をスナップショットする (super_admin 監視用)。
 *
 * ADR-0022 (2026-06-01) 後は Beginner プランのみが対象。Expert/Pro は budget cap で防御済のため
 * 監視不要。
 */
export async function listFairUseUsage(now: Date = new Date()): Promise<
  Array<{
    tenantId: string;
    tenantName: string;
    usedCount: number;
    status: 'ok' | 'warning' | 'hard';
  }>
> {
  // ADR-0022: Beginner プランのみ対象 (= Expert/Pro は cost > 0 で budget cap が動く)
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null, plan: 'beginner' },
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
