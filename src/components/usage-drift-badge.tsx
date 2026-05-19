/**
 * API 利用量 drift 警告 chip (2026-05-14, PR-V8 2026-05-19 強化)
 *
 * `Tenant.currentMonthApiCallCount` / `currentMonthApiCostJpy` (リアルタイム counter) と
 * `ApiCallLog` SUM (整合性検証用) の差分が 5% 以上ある場合に警告 chip を表示する。
 *
 * PR-V8 強化:
 *   - 呼出回数 drift / 費用 drift を併記 (Beginner プラン cost=0 でも call drift を可視化)
 *   - 「詳細を見る」リンクを追加 (= /admin/super/diagnostics へ誘導)
 *   - tooltip により詳細値 (cached / reconciled / 差分) を maintainer 向けに保持
 *
 * 用途:
 *   - super_admin: 課金根拠の整合性検証
 *   - テナント管理者: 自テナント値が ApiCallLog と一致しているかの監視
 *
 * 関連:
 *   - サービス: src/services/api-usage-recalc.service.ts
 *   - 診断ダッシュボード: src/app/(dashboard)/admin/super/diagnostics/page.tsx
 */

import Link from 'next/link';
// 2026-05-14: Client から参照されるため、閾値は @/config/api-usage-drift (pure module) から、
//   型は service から type-only 取得。これにより Client bundle に Prisma 依存が混入しない。
import { DRIFT_WARNING_THRESHOLD } from '@/config/api-usage-drift';
import type { ApiUsageReconcileResult } from '@/services/api-usage-recalc.service';

export type UsageDriftBadgeProps = {
  /** reconcile 結果。null の場合は何も表示しない */
  reconcile: ApiUsageReconcileResult | null;
  /** PR-V8: 「詳細を見る」リンクを表示するか (= super_admin 画面のみ true) */
  showDiagnosticsLink?: boolean;
};

export function UsageDriftBadge({
  reconcile,
  showDiagnosticsLink = false,
}: UsageDriftBadgeProps) {
  if (!reconcile) return null;
  if (!reconcile.hasDrift) {
    // drift が閾値未満 = 健全。表示しない (UI ノイズ削減)
    return null;
  }

  const callDriftPercent = (reconcile.driftCallRatio * 100).toFixed(1);
  const costDriftPercent = (reconcile.driftCostRatio * 100).toFixed(1);
  const driftCostSign = reconcile.driftCostJpy >= 0 ? '+' : '';
  const driftCallSign = reconcile.driftCallCount >= 0 ? '+' : '';
  const directionLabel =
    reconcile.driftCallCount > 0 || reconcile.driftCostJpy > 0
      ? 'counter > log (counter 過剰)'
      : 'counter < log (counter 不足)';

  // PR-V8: cost drift が支配的か / call drift が支配的か を文言で表現
  //   Beginner プランは cost=0 なので必ず call drift 表記になる
  const primaryMetric =
    reconcile.driftCallRatio >= reconcile.driftCostRatio
      ? `呼出回数 ${callDriftPercent}%`
      : `費用 ${costDriftPercent}%`;

  return (
    <span
      className="ml-1 inline-flex items-center gap-1 rounded-full border border-amber-400 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
      title={[
        `ApiCallLog SUM との drift を検出 (>= ${(DRIFT_WARNING_THRESHOLD * 100).toFixed(0)}%)。`,
        '',
        `[呼出回数]`,
        `  counter: ${reconcile.cachedCallCount.toLocaleString()} 回`,
        `  ApiCallLog SUM: ${reconcile.reconciledCallCount.toLocaleString()} 回`,
        `  差分: ${driftCallSign}${reconcile.driftCallCount.toLocaleString()} 回 (${callDriftPercent}%)`,
        '',
        `[費用]`,
        `  counter: ¥${reconcile.cachedCostJpy.toLocaleString()}`,
        `  ApiCallLog SUM: ¥${reconcile.reconciledCostJpy.toLocaleString()}`,
        `  差分: ${driftCostSign}¥${reconcile.driftCostJpy.toLocaleString()} (${costDriftPercent}%)`,
        '',
        `→ ${directionLabel}`,
        `→ 月境界 (テナント TZ): ${reconcile.monthStart.toISOString()}`,
      ].join('\n')}
    >
      ⚠ drift {primaryMetric}
      {showDiagnosticsLink && (
        <Link
          href={`/admin/super/tenants/${reconcile.tenantId}/diagnostics`}
          className="ml-1 underline hover:text-amber-700"
        >
          詳細
        </Link>
      )}
    </span>
  );
}
