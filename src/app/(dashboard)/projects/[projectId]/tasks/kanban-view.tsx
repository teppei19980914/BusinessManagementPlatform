'use client';

import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  getAllCalendarDays,
  distributeEffortByDay,
  getProjectDateRange,
  clampMaxDateToToday,
} from '@/lib/task-day-distribution';
import { getJapaneseHoliday, isWeekendOrHoliday } from '@/lib/jp-holidays';
import { useToast } from '@/components/toast-provider';
import { WORKLOAD_WARN_HOURS, WORKLOAD_ALERT_HOURS } from '@/config/workload';
import { TaskChip } from './task-chip';
import type { TaskDTO } from '@/services/task.service';
import type { MemberDTO } from '@/services/member.service';

type Props = {
  /** フィルター後のタスク一覧 (WP・ACT 混在でよい。本コンポーネント内で ACT のみ抽出) */
  tasks: TaskDTO[];
  members: MemberDTO[];
  selectedIds: Set<string>;
  canSelectForProgress: boolean;
  onToggleSelect: (id: string) => void;
  onEditClick: (task: TaskDTO) => void;
  /** テナント TZ 基準でサーバが算出した「今日」(YYYY-MM-DD)。初期スクロール・今日列強調に使用 */
  today: string;
  /** ドラッグ&ドロップによるタスク移動を許可するか (admin / pm_tl のみ true) */
  canDragDrop?: boolean;
  /**
   * ドロップ完了時に呼び出されるコールバック。
   * tasks-client.tsx 側で PATCH API 呼び出し + reload を担当する。
   */
  onTaskDrop?: (
    taskId: string,
    newStartDate: string,
    newEndDate: string,
    newAssigneeId: string | null,
    includeWeekends: boolean,
  ) => Promise<void>;
};

/** YYYY-MM-DD 文字列を UTC 午前0時の Date に変換 */
function parseUTCDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** YYYY-MM-DD を deltaDays 日ずらした YYYY-MM-DD を返す */
function shiftDate(dateStr: string, deltaDays: number): string {
  const date = parseUTCDate(dateStr);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 2 つの YYYY-MM-DD の差分を日数で返す (target - source) */
function dayDiff(source: string, target: string): number {
  return Math.round(
    (parseUTCDate(target).getTime() - parseUTCDate(source).getTime()) / (24 * 60 * 60 * 1000),
  );
}

/** 日付が土日祝の場合、直前の平日にスナップする */
function snapToPrevBusinessDay(dateStr: string): string {
  let d = dateStr;
  while (isWeekendOrHoliday(d)) d = shiftDate(d, -1);
  return d;
}

/** 日付が土日祝の場合、直後の平日にスナップする */
function snapToNextBusinessDay(dateStr: string): string {
  let d = dateStr;
  while (isWeekendOrHoliday(d)) d = shiftDate(d, 1);
  return d;
}

/** 暦日列のヘッダー日付を短い形式 (MM/DD) で返す */
function formatColumnDate(dateStr: string): string {
  const [, m, d] = dateStr.split('-');
  return `${parseInt(m)}/${parseInt(d)}`;
}

type ColumnMeta = {
  date: string;
  dow: string;
  dayOfWeek: number;
  holidayName: string | null;
};

function buildColumnMeta(dateStr: string, dayLabels: string[]): ColumnMeta {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return {
    date: formatColumnDate(dateStr),
    dow: dayLabels[dayOfWeek],
    dayOfWeek,
    holidayName: getJapaneseHoliday(dateStr),
  };
}

/** 列ヘッダーの背景クラス（土=青、日/祝=赤、今日=情報色） */
function getColHeaderBg(dateStr: string, meta: ColumnMeta, today: string): string {
  if (dateStr === today) return 'bg-info/20 dark:bg-info/10';
  if (meta.dayOfWeek === 6) return 'bg-blue-50 dark:bg-blue-950/30';
  if (meta.dayOfWeek === 0 || meta.holidayName !== null) return 'bg-red-50 dark:bg-red-950/30';
  return '';
}

/** 列ヘッダーのテキストクラス */
function getColHeaderTextClass(meta: ColumnMeta, isToday: boolean): string {
  if (isToday) return 'font-bold text-info';
  if (meta.dayOfWeek === 6) return 'text-blue-600 dark:text-blue-400';
  if (meta.dayOfWeek === 0 || meta.holidayName !== null) return 'text-red-500 dark:text-red-400';
  return '';
}

/** データセルの背景クラス（過負荷警告 > 土/日/祝 > 今日 > 通常） */
function getCellBg(dateStr: string, meta: ColumnMeta, today: string, totalEffort: number): string {
  if (totalEffort >= WORKLOAD_ALERT_HOURS) return 'bg-red-50 dark:bg-red-950/30';
  if (totalEffort >= WORKLOAD_WARN_HOURS) return 'bg-yellow-50 dark:bg-yellow-950/30';
  if (dateStr === today) return 'bg-info/10 dark:bg-info/5';
  if (meta.dayOfWeek === 6) return 'bg-blue-50/50 dark:bg-blue-950/20';
  if (meta.dayOfWeek === 0 || meta.holidayName !== null) return 'bg-red-50/50 dark:bg-red-950/20';
  return '';
}

/** ドラッグ中のタスク情報 */
type DragState = {
  taskId: string;
  /** ドラッグ開始元の列日付 (デルタ計算の基準) */
  sourceDate: string;
  sourceAssigneeId: string | null;
  plannedStartDate: string;
  plannedEndDate: string;
  includeWeekends: boolean;
};

export function KanbanView({
  tasks,
  members,
  selectedIds,
  canSelectForProgress,
  onToggleSelect,
  onEditClick,
  today,
  canDragDrop = false,
  onTaskDrop,
}: Props) {
  const t = useTranslations('wbs');
  const { showError } = useToast();

  // 曜日ラベル (日〜土, index=0〜6)
  const dayLabels = useMemo(
    () => [
      t('kanbanDow0'), t('kanbanDow1'), t('kanbanDow2'), t('kanbanDow3'),
      t('kanbanDow4'), t('kanbanDow5'), t('kanbanDow6'),
    ],
    [t],
  );

  // activity のみ対象 (work_package はカンバンに表示しない)
  const actTasks = useMemo(
    () => tasks.filter((t) => t.type === 'activity'),
    [tasks],
  );

  // プロジェクト全体の暦日列（土日祝含む全暦日）
  // clampMaxDateToToday で today を必ず末端に含める。
  // スクロールは useEffect で today 列を目標に設定するが、ACT タスクが today より前に終わる場合は
  // ブラウザが maxScrollLeft にクランプするため、タスク列が見える位置に自然に収まる。
  const { minDate, maxDate } = useMemo(
    () => clampMaxDateToToday(getProjectDateRange(actTasks), today),
    [actTasks, today],
  );
  const calendarDays = useMemo(
    () => getAllCalendarDays(minDate, maxDate),
    [minDate, maxDate],
  );

  // 列メタデータ（曜日・祝日名）を事前計算
  const columnMetaList = useMemo(
    () => calendarDays.map((day) => buildColumnMeta(day, dayLabels)),
    [calendarDays, dayLabels],
  );

  // 担当者の一意リスト (フィルター後 ACT に登場するもの)
  const assigneeIds = useMemo(() => {
    const ids = new Set<string | null>();
    for (const task of actTasks) {
      ids.add(task.assigneeId ?? null);
    }
    const sorted: (string | null)[] = [];
    for (const id of ids) {
      if (id !== null) sorted.push(id);
    }
    if (ids.has(null)) sorted.push(null);
    return sorted;
  }, [actTasks]);

  // memberId → 表示名 のマップ
  const memberNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      map.set(m.userId, m.userName ?? m.userEmail);
    }
    return map;
  }, [members]);

  // タスクごとの日次工数分散: taskId → DayEntry[]
  const distributionByTaskId = useMemo(() => {
    const map = new Map<string, ReturnType<typeof distributeEffortByDay>>();
    for (const task of actTasks) {
      map.set(
        task.id,
        distributeEffortByDay(
          task.plannedStartDate ?? null,
          task.plannedEndDate ?? null,
          task.plannedEffort ?? 0,
          task.includeWeekends,
        ),
      );
    }
    return map;
  }, [actTasks]);

  // 未スケジュールタスク: 開始予定日または終了予定日が未設定のもの
  const unscheduledTasks = useMemo(
    () => actTasks.filter((task) => !task.plannedStartDate || !task.plannedEndDate),
    [actTasks],
  );

  // グリッドデータ: assigneeId × date → CellData
  type CellData = { task: TaskDTO; dailyEffort: number }[];
  const grid = useMemo(() => {
    const map = new Map<string | null, Map<string, CellData>>();
    for (const assigneeId of assigneeIds) {
      map.set(assigneeId, new Map<string, CellData>());
    }
    for (const task of actTasks) {
      const assigneeId = task.assigneeId ?? null;
      const entries = distributionByTaskId.get(task.id) ?? [];
      const row = map.get(assigneeId);
      if (!row) continue;
      for (const { date, dailyEffort } of entries) {
        if (!row.has(date)) row.set(date, []);
        row.get(date)!.push({ task, dailyEffort });
      }
    }
    return map;
  }, [actTasks, assigneeIds, distributionByTaskId]);

  // 初期スクロール — ガントと同じ useEffect (ペイント後の DOM 測定) 方式。
  // ガントは固定幅 DAY_WIDTH で算術計算できるが、カンバンはタスクチップで列幅が可変になるため
  // DOM の offsetLeft 実測値を使う。deps を [today] のみにすることでフィルター操作による
  // 再スクロールを防ぐ（ガントと同思想）。
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const todayTh = el.querySelector<HTMLElement>(`th[data-date="${today}"]`);
    if (!todayTh) return;
    const stickyTh = el.querySelector<HTMLElement>('th:first-child');
    const stickyWidth = stickyTh?.offsetWidth ?? 112;
    el.scrollLeft = Math.max(0, todayTh.offsetLeft - stickyWidth);
  }, [today]);

  // ── DnD ステート ──
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<{ date: string; assigneeId: string | null } | null>(null);
  const [isDropping, setIsDropping] = useState(false);

  const handleDragStart = useCallback(
    (task: TaskDTO, sourceDate: string, e: React.DragEvent<HTMLDivElement>) => {
      if (!task.plannedStartDate || !task.plannedEndDate) return;
      e.dataTransfer.effectAllowed = 'move';
      // Firefox では dataTransfer.setData が必須
      e.dataTransfer.setData('text/plain', task.id);
      setDragState({
        taskId: task.id,
        sourceDate,
        sourceAssigneeId: task.assigneeId ?? null,
        plannedStartDate: task.plannedStartDate,
        plannedEndDate: task.plannedEndDate,
        includeWeekends: task.includeWeekends,
      });
    },
    [],
  );

  const handleDragEnd = useCallback(() => {
    setDragState(null);
    setDropTarget(null);
  }, []);

  const handleDragOver = useCallback(
    (date: string, assigneeId: string | null, e: React.DragEvent<HTMLTableCellElement>) => {
      if (!dragState) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget((prev) =>
        prev?.date === date && prev?.assigneeId === assigneeId ? prev : { date, assigneeId },
      );
    },
    [dragState],
  );

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLTableCellElement>) => {
    // relatedTarget がセル内の子要素の場合は leave 扱いにしない
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDropTarget(null);
  }, []);

  const handleDrop = useCallback(
    async (targetDate: string, targetAssigneeId: string | null, e: React.DragEvent<HTMLTableCellElement>) => {
      e.preventDefault();
      setDropTarget(null);
      if (!dragState || !onTaskDrop) return;

      const delta = dayDiff(dragState.sourceDate, targetDate);
      const sameDate = delta === 0;
      const sameAssignee = targetAssigneeId === dragState.sourceAssigneeId;
      if (sameDate && sameAssignee) {
        setDragState(null);
        return;
      }

      let newStart = shiftDate(dragState.plannedStartDate, delta);
      let newEnd = shiftDate(dragState.plannedEndDate, delta);

      // 土日祝日チェック: includeWeekends=false のとき
      if (!dragState.includeWeekends) {
        const isSingleDay = dragState.plannedStartDate === dragState.plannedEndDate;
        if (isSingleDay && isWeekendOrHoliday(newStart)) {
          // 単日タスクを土日祝列にドロップ → エラーして移動しない
          showError(t('kanbanDropWeekendError'));
          setDragState(null);
          return;
        }
        // 複数日タスク → 開始を直前平日・終了を直後平日にスナップ
        newStart = snapToPrevBusinessDay(newStart);
        newEnd = snapToNextBusinessDay(newEnd);
      }

      setIsDropping(true);
      try {
        await onTaskDrop(dragState.taskId, newStart, newEnd, targetAssigneeId, dragState.includeWeekends);
      } finally {
        setIsDropping(false);
        setDragState(null);
      }
    },
    [dragState, onTaskDrop],
  );

  if (actTasks.length === 0) {
    return (
      <div className="hidden py-8 text-center text-sm text-muted-foreground md:block">
        {t('noTasks')}
      </div>
    );
  }

  return (
    <div className="hidden md:block">
      <div
        ref={scrollContainerRef}
        className={`overflow-auto rounded-lg border max-h-[calc(100vh-14rem)] ${isDropping ? 'pointer-events-none' : ''}`}
      >
        <table className="min-w-max border-collapse text-xs">
          {/* ヘッダー行: 担当者 + 暦日列 */}
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              <th className="sticky left-0 z-20 min-w-[7rem] border-b border-r border-border bg-muted px-3 py-2 text-left text-sm font-medium">
                {t('columnAssignee')}
              </th>
              {calendarDays.map((day, i) => {
                const meta = columnMetaList[i];
                const isToday = day === today;
                const headerBg = getColHeaderBg(day, meta, today);
                const textClass = getColHeaderTextClass(meta, isToday);
                return (
                  <th
                    key={day}
                    data-date={day}
                    className={`min-w-[5rem] border-b border-r border-border px-2 py-1 text-center font-medium ${headerBg}`}
                    title={meta.holidayName ?? undefined}
                  >
                    <div className={textClass}>{meta.date}</div>
                    <div className="text-foreground/50 font-normal">({meta.dow})</div>
                    {meta.holidayName && (
                      <div className="text-[9px] text-red-500 dark:text-red-400 truncate leading-tight max-w-[4.5rem]">
                        {meta.holidayName}
                      </div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {assigneeIds.map((assigneeId) => {
              const assigneeName = assigneeId
                ? (memberNameById.get(assigneeId) ?? t('kanbanNoAssignee'))
                : t('kanbanNoAssignee');
              const row = grid.get(assigneeId);

              return (
                <tr key={assigneeId ?? '__no_assignee__'} className="border-b border-border">
                  <td className="sticky left-0 z-10 border-r border-border bg-card px-3 py-2 text-sm font-medium whitespace-nowrap align-top">
                    {assigneeName}
                  </td>
                  {calendarDays.map((day, i) => {
                    const meta = columnMetaList[i];
                    const chips = row?.get(day) ?? [];
                    const totalEffort = chips.reduce((sum, c) => sum + c.dailyEffort, 0);
                    const bgClass = getCellBg(day, meta, today, totalEffort);
                    const isDropHere =
                      dropTarget?.date === day && dropTarget?.assigneeId === assigneeId;

                    return (
                      <td
                        key={day}
                        className={[
                          'min-w-[5rem] border-r border-border px-1 py-1 align-top transition-all',
                          bgClass,
                          isDropHere ? 'ring-2 ring-inset ring-primary bg-primary/5' : '',
                        ].join(' ')}
                        onDragOver={
                          canDragDrop ? (e) => handleDragOver(day, assigneeId, e) : undefined
                        }
                        onDragLeave={canDragDrop ? handleDragLeave : undefined}
                        onDrop={
                          canDragDrop ? (e) => handleDrop(day, assigneeId, e) : undefined
                        }
                      >
                        <div className="flex flex-col gap-1">
                          {chips.map(({ task, dailyEffort }) => {
                            const isDragging = dragState?.taskId === task.id;
                            return (
                              <TaskChip
                                key={task.id}
                                task={task}
                                dailyEffort={dailyEffort}
                                isSelected={selectedIds.has(task.id)}
                                canSelectForProgress={canSelectForProgress}
                                onToggleSelect={onToggleSelect}
                                onEditClick={onEditClick}
                                draggable={canDragDrop}
                                isDragging={isDragging}
                                onDragStart={(e) => handleDragStart(task, day, e)}
                              />
                            );
                          })}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}

            {/* 未スケジュール行（DnD 対象外: 日付なしでデルタ計算不可） */}
            {unscheduledTasks.length > 0 && (
              <tr className="border-b border-border bg-muted/30">
                <td
                  className="sticky left-0 z-10 border-r border-border bg-muted/50 px-3 py-2 text-sm font-medium whitespace-nowrap align-top"
                  data-testid="kanban-unscheduled-row"
                >
                  {t('kanbanUnscheduledSection')}
                </td>
                <td colSpan={calendarDays.length} className="px-2 py-2">
                  <div className="flex flex-wrap gap-1">
                    {unscheduledTasks.map((task) => (
                      <TaskChip
                        key={task.id}
                        task={task}
                        dailyEffort={task.plannedEffort ?? 0}
                        isSelected={selectedIds.has(task.id)}
                        canSelectForProgress={canSelectForProgress}
                        onToggleSelect={onToggleSelect}
                        onEditClick={onEditClick}
                        draggable={false}
                      />
                    ))}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 凡例 */}
      <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded bg-blue-100 dark:bg-blue-900/50 border border-blue-200 dark:border-blue-800" />
          {t('kanbanLegendSaturday')}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded bg-red-100 dark:bg-red-900/50 border border-red-200 dark:border-red-800" />
          {t('kanbanLegendHoliday')}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded bg-yellow-200 dark:bg-yellow-800" />
          {t('kanbanLegendWarn', { hours: WORKLOAD_WARN_HOURS })}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded bg-red-200 dark:bg-red-800" />
          {t('kanbanLegendAlert', { hours: WORKLOAD_ALERT_HOURS })}
        </span>
        {canDragDrop && (
          <span className="flex items-center gap-1 text-muted-foreground/70">
            ☰ {t('kanbanLegendDragDrop')}
          </span>
        )}
      </div>

      {/* ドラッグ中のグローバル dragend 補足（ブラウザがドロップ対象外でキャンセルしたとき用） */}
      {dragState && (
        <div
          className="fixed inset-0 z-50"
          style={{ pointerEvents: 'none' }}
          onDragEnd={handleDragEnd}
        />
      )}
    </div>
  );
}
