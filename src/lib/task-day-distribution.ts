/**
 * WBS カンバンビュー用: 日次工数分散ロジック
 *
 * 役割:
 *   ACT の総予定工数を稼働日ごとに均等分散し、カンバングリッドの付箋高さ計算に使用する。
 *
 * 設計判断:
 *   - includeWeekends=true : 全暦日で分散（例: 金〜月 4h → 1h/日）
 *   - includeWeekends=false: 業務日（月〜金、祝日除く）のみで分散（例: 金〜月 4h → 金2h/月2h）
 *   - 日付未設定・工数未設定の場合は未スケジュール扱い
 *   - start=end（単日）の場合は全工数をその日に配置
 *   - 最低付箋高さ確保のため、0 工数タスクも日付があれば entries に含める
 *
 * 関連:
 *   - src/app/(dashboard)/projects/[projectId]/tasks/kanban-view.tsx
 *   - src/config/workload.ts (閾値定数 WORKLOAD_WARN_HOURS / WORKLOAD_ALERT_HOURS)
 *   - src/lib/jp-holidays.ts (isWeekendOrHoliday)
 */

import { isWeekendOrHoliday } from './jp-holidays';

export type DayEntry = {
  /** YYYY-MM-DD */
  date: string;
  /** その日の割り当て工数（時間） */
  dailyEffort: number;
};

/**
 * 日付文字列（YYYY-MM-DD）を UTC 午前0時の Date に変換する。
 * タイムゾーンのズレで日付がズレないよう、常に UTC で扱う。
 */
function parseDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * startDate〜endDate（両端含む）の全暦日（土日・祝日を含む）一覧を返す。
 * 日付未設定・startDate > endDate の場合は空配列を返す。
 */
export function getAllCalendarDays(startDate: string | null, endDate: string | null): string[] {
  if (!startDate || !endDate) return [];

  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (start > end) return [];

  const days: string[] = [];
  const current = new Date(start);
  while (current <= end) {
    const y = current.getUTCFullYear();
    const m = String(current.getUTCMonth() + 1).padStart(2, '0');
    const d = String(current.getUTCDate()).padStart(2, '0');
    days.push(`${y}-${m}-${d}`);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return days;
}

/**
 * startDate〜endDate（両端含む）の業務日（土日・祝日を除く平日）一覧を返す。
 * 日付未設定・startDate > endDate の場合は空配列を返す。
 */
export function getBusinessDays(startDate: string | null, endDate: string | null): string[] {
  return getAllCalendarDays(startDate, endDate).filter((d) => !isWeekendOrHoliday(d));
}

/**
 * 稼働日数を返す。includeWeekends=true なら全暦日数、false なら業務日数。
 * 表示用（「稼働日数: X 日」）に使用する。
 */
export function countWorkingDays(
  startDate: string | null,
  endDate: string | null,
  includeWeekends: boolean,
): number {
  if (includeWeekends) return getAllCalendarDays(startDate, endDate).length;
  return getBusinessDays(startDate, endDate).length;
}

/**
 * タスクの総予定工数を稼働日ごとに均等分散した DayEntry 配列を返す。
 *
 * @param includeWeekends true=全暦日, false=業務日のみ（デフォルト: false）
 * 返り値が空配列 = 未スケジュール（日付未設定）。
 * plannedEffort が 0 や未設定の場合は dailyEffort=0 で entries を返す（最低高さ付箋用）。
 */
export function distributeEffortByDay(
  plannedStartDate: string | null,
  plannedEndDate: string | null,
  plannedEffort: number,
  includeWeekends: boolean = false,
): DayEntry[] {
  const days = includeWeekends
    ? getAllCalendarDays(plannedStartDate, plannedEndDate)
    : getBusinessDays(plannedStartDate, plannedEndDate);
  if (days.length === 0) return [];

  const dailyEffort = plannedEffort > 0
    ? Math.round((plannedEffort / days.length) * 100) / 100
    : 0;

  return days.map((date) => ({ date, dailyEffort }));
}

/**
 * プロジェクト内の全 ACT タスクから全暦日の最小・最大を求める。
 * 表示期間の自動決定に使用する。
 * タスクがない・全て未スケジュールの場合は今日から30日を返す。
 */
export function getProjectDateRange(
  tasks: Array<{ plannedStartDate: string | null; plannedEndDate: string | null }>,
): { minDate: string; maxDate: string } {
  const dates: string[] = [];
  for (const t of tasks) {
    if (t.plannedStartDate) dates.push(t.plannedStartDate);
    if (t.plannedEndDate) dates.push(t.plannedEndDate);
  }

  if (dates.length === 0) {
    const today = new Date();
    const future = new Date(today);
    future.setDate(future.getDate() + 30);
    return {
      minDate: today.toISOString().slice(0, 10),
      maxDate: future.toISOString().slice(0, 10),
    };
  }

  dates.sort();
  return { minDate: dates[0], maxDate: dates[dates.length - 1] };
}

/**
 * タスク期間が今日より前に終わる場合も今日列をカレンダーに含めるため maxDate を補正する。
 * カンバンビューの初期スクロール（今日を左端に表示）で使用。
 */
export function clampMaxDateToToday(
  range: { minDate: string; maxDate: string },
  today: string,
): { minDate: string; maxDate: string } {
  if (!today || range.maxDate >= today) return range;
  return { ...range, maxDate: today };
}
