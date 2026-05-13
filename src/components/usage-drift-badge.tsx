/**
 * API 利用量 drift 警告 chip (2026-05-14)
 *
 * `Tenant.currentMonthApiCallCount` / `currentMonthApiCostJpy` (リアルタイム counter) と
 * `ApiCallLog` SUM (整合性検証用) の差分が 5% 以上ある場合に警告 chip を表示する。
 *
 * 用途:
 *   - super_admin: 課金根拠の整合性検証
 *   - テナント管理者: 自テナント値が ApiCallLog と一致しているかの監視
 *
 * 関連:
 *   - サービス: src/services/api-usage-recalc.service.ts
 *   - 計画: docs/plans/2026-05-14_dashboard_realtime_recalc.md
 */

// 2026-05-14: Client から参照されるため、閾値は @/config/api-usage-drift (pure module) から、
//   型は service から type-only 取得。これにより Client bundle に Prisma 依存が混入しない。
import { DRIFT_WARNING_THRESHOLD } from '@/config/api-usage-drift';
import type { ApiUsageReconcileResult } from '@/services/api-usage-recalc.service';

export type UsageDriftBadgeProps = {
  /** reconcile 結果。null の場合は何も表示しない */
  reconcile: ApiUsageReconcileResult | null;
};

export function UsageDriftBadge({ reconcile }: UsageDriftBadgeProps) {
  if (!reconcile) return null;
  if (!reconcile.hasDrift) {
    // drift が閾値未満 = 健全。表示しない (UI ノイズ削減)
    return null;
  }

  const driftPercent = (reconcile.driftRatio * 100).toFixed(1);
  const driftCostSign = reconcile.driftCostJpy >= 0 ? '+' : '';
  const directionLabel =
    reconcile.driftCostJpy > 0
      ? 'counter > log (counter 過剰)'
      : 'counter < log (counter 不足)';

  return (
    <span
      className="ml-1 inline-flex items-center gap-1 rounded-full border border-amber-400 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
      title={[
        `ApiCallLog SUM との drift を検出 (>= ${(DRIFT_WARNING_THRESHOLD * 100).toFixed(0)}%)。`,
        `cached: ¥${reconcile.cachedCostJpy.toLocaleString()} (${reconcile.cachedCallCount.toLocaleString()} 回)`,
        `reconciled: ¥${reconcile.reconciledCostJpy.toLocaleString()} (${reconcile.reconciledCallCount.toLocaleString()} 回)`,
        `差分: ${driftCostSign}¥${reconcile.driftCostJpy.toLocaleString()} (${driftCostSign}${reconcile.driftCallCount.toLocaleString()} 回)`,
        `→ ${directionLabel}`,
      ].join('\n')}
    >
      ⚠ drift {driftPercent}%
    </span>
  );
}
