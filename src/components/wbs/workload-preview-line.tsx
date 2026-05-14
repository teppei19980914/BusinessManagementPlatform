/**
 * WorkloadPreviewLine (PR #361 / 2026-05-14)
 *
 * ACT 作成・編集 dialog 内で「最大日工数: 9.5h (2026-06-15)」を 1 行表示する
 * シンプルなプレビューコンポーネント。レベル別に色付け:
 *   - ok (8h 以下) → muted-foreground (通常)
 *   - warning (7h 超) → amber-600 (黄色)
 *   - alert (8h 超) → destructive (赤)
 *
 * Server-safe (Prisma 非依存)。pure presentation component。
 */

import type { WorkloadPreviewData } from '@/components/hooks/use-workload-preview';
import { WORKLOAD_WARN_HOURS, WORKLOAD_ALERT_HOURS } from '@/config/workload';

export type WorkloadPreviewLineProps = {
  data: WorkloadPreviewData | null;
  isLoading: boolean;
};

export function WorkloadPreviewLine({ data, isLoading }: WorkloadPreviewLineProps) {
  if (isLoading) {
    return (
      <p className="text-xs text-muted-foreground" aria-live="polite">
        工数を集計中…
      </p>
    );
  }
  if (!data || data.maxDailyDate == null) {
    return null;
  }

  const colorClass =
    data.level === 'alert'
      ? 'text-destructive font-semibold'
      : data.level === 'warning'
        ? 'text-amber-600 dark:text-amber-400 font-semibold'
        : 'text-muted-foreground';

  const icon = data.level === 'alert' ? '🚨' : data.level === 'warning' ? '⚠️' : '✓';

  const note =
    data.level === 'alert'
      ? `（1 日 ${WORKLOAD_ALERT_HOURS}h 超: 担当者の他タスクと合算するとオーバーアサインの可能性）`
      : data.level === 'warning'
        ? `（1 日 ${WORKLOAD_WARN_HOURS}h 超: 余裕なし、調整推奨）`
        : '';

  return (
    <p className={`text-xs ${colorClass}`} aria-live="polite">
      {icon} 最大日工数: {data.maxDailyEffort.toFixed(1)}h ({data.maxDailyDate})
      {note && <span className="ml-1 text-xs font-normal">{note}</span>}
    </p>
  );
}
