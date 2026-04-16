'use client';

import { useMemo } from 'react';
import type { TaskDTO } from '@/services/task.service';

type Props = {
  projectId: string;
  tasks: TaskDTO[];
};

function daysBetween(start: string, end: string): number {
  const s = new Date(start);
  const e = new Date(end);
  return Math.ceil((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24));
}

function dayOffset(base: string, date: string): number {
  const b = new Date(base);
  const d = new Date(date);
  return Math.ceil((d.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

/** 日付を YYYY-MM-DD 形式にフォーマット */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/** 曜日ラベル */
const DAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

/** 1日あたりの最小幅(px) */
const DAY_WIDTH = 32;

export function GanttClient({ tasks: allTasks }: Props) {
  const today = useMemo(() => new Date().toISOString().split('T')[0], []);

  // アクティビティのみ表示（WP は除外）
  const tasks = useMemo(
    () => allTasks.filter((t) => t.type === 'activity' && t.plannedStartDate && t.plannedEndDate),
    [allTasks],
  );

  const { minDate, totalDays } = useMemo(() => {
    if (tasks.length === 0) {
      return { minDate: today, totalDays: 30 };
    }
    const starts = tasks.map((t) => t.plannedStartDate!);
    const ends = tasks.map((t) => t.plannedEndDate!);
    const min = starts.sort()[0];
    const max = ends.sort().reverse()[0];
    return { minDate: min, totalDays: Math.max(daysBetween(min, max) + 1, 7) };
  }, [tasks, today]);

  // 月ヘッダー生成（日単位グリッドの上段）
  const monthHeaders = useMemo(() => {
    const headers: { label: string; span: number }[] = [];
    const start = new Date(minDate);
    let currentMonth = -1;
    let currentYear = -1;

    for (let i = 0; i < totalDays; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const m = d.getMonth();
      const y = d.getFullYear();
      if (m !== currentMonth || y !== currentYear) {
        headers.push({ label: `${y}/${m + 1}月`, span: 1 });
        currentMonth = m;
        currentYear = y;
      } else {
        headers[headers.length - 1].span++;
      }
    }
    return headers;
  }, [minDate, totalDays]);

  // 日単位ヘッダー生成
  const dayHeaders = useMemo(() => {
    const headers: { date: string; day: number; dayOfWeek: number }[] = [];
    const start = new Date(minDate);

    for (let i = 0; i < totalDays; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      headers.push({
        date: formatDate(d),
        day: d.getDate(),
        dayOfWeek: d.getDay(),
      });
    }
    return headers;
  }, [minDate, totalDays]);

  const chartWidth = totalDays * DAY_WIDTH;

  if (tasks.length === 0) {
    return (
      <div className="space-y-6">
        <h2 className="text-xl font-semibold">ガントチャート</h2>
        <p className="py-8 text-center text-gray-500">タスクがありません</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">ガントチャート</h2>
      <div className="overflow-x-auto rounded-lg border">
        <div style={{ minWidth: `${200 + chartWidth}px` }}>
          {/* ヘッダー: 月 */}
          <div className="flex border-b bg-gray-50">
            <div className="w-52 shrink-0 border-r" />
            <div className="flex">
              {monthHeaders.map((mh, i) => (
                <div
                  key={i}
                  className="border-r px-1 py-1 text-center text-xs font-medium text-gray-600"
                  style={{ width: `${mh.span * DAY_WIDTH}px` }}
                >
                  {mh.label}
                </div>
              ))}
            </div>
          </div>

          {/* ヘッダー: 日 */}
          <div className="flex border-b bg-gray-50">
            <div className="w-52 shrink-0 border-r px-3 py-1 text-xs font-medium">タスク名</div>
            <div className="flex">
              {dayHeaders.map((dh, i) => {
                const isWeekend = dh.dayOfWeek === 0 || dh.dayOfWeek === 6;
                const isToday = dh.date === today;
                return (
                  <div
                    key={i}
                    className={`border-r py-1 text-center text-[10px] leading-tight ${
                      isToday ? 'bg-blue-100 font-bold text-blue-700' : isWeekend ? 'bg-gray-100 text-gray-400' : 'text-gray-500'
                    }`}
                    style={{ width: `${DAY_WIDTH}px` }}
                  >
                    <div>{dh.day}</div>
                    <div>{DAY_LABELS[dh.dayOfWeek]}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* タスク行 */}
          {tasks.map((task) => {
            const startDate = task.plannedStartDate!;
            const endDate = task.plannedEndDate!;
            const offset = dayOffset(minDate, startDate);
            const duration = daysBetween(startDate, endDate) + 1;
            const leftPx = offset * DAY_WIDTH;
            const widthPx = duration * DAY_WIDTH;
            const isDelayed = task.status !== 'completed' && new Date(endDate) < new Date();

            return (
              <div key={task.id} className="flex border-b hover:bg-gray-50">
                <div className="w-52 shrink-0 border-r px-3 py-2">
                  {task.parentTaskName && (
                    <div className="truncate text-[10px] text-gray-400">{task.parentTaskName}</div>
                  )}
                  <div className="truncate text-sm font-medium">{task.name}</div>
                  <div className="text-xs text-gray-400">{task.assigneeName}</div>
                </div>
                <div className="relative" style={{ width: `${chartWidth}px` }}>
                  {/* 週末背景 */}
                  {dayHeaders.map((dh, i) => {
                    const isWeekend = dh.dayOfWeek === 0 || dh.dayOfWeek === 6;
                    const isToday = dh.date === today;
                    if (!isWeekend && !isToday) return null;
                    return (
                      <div
                        key={i}
                        className={`absolute top-0 h-full ${isToday ? 'bg-blue-50' : 'bg-gray-50'}`}
                        style={{ left: `${i * DAY_WIDTH}px`, width: `${DAY_WIDTH}px` }}
                      />
                    );
                  })}
                  {/* バー */}
                  <div
                    className="absolute top-2 h-6 rounded"
                    style={{
                      left: `${leftPx}px`,
                      width: `${Math.max(widthPx, DAY_WIDTH)}px`,
                    }}
                  >
                    {task.isMilestone ? (
                      <div className="flex h-6 items-center justify-center">
                        <div className="h-3 w-3 rotate-45 bg-purple-500" />
                      </div>
                    ) : (
                      <div className={`h-6 rounded ${isDelayed ? 'bg-red-200' : 'bg-blue-200'}`}>
                        <div
                          className={`h-6 rounded ${isDelayed ? 'bg-red-500' : 'bg-blue-500'}`}
                          style={{ width: `${task.progressRate}%` }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 凡例 */}
      <div className="flex gap-4 text-xs text-gray-500">
        <div className="flex items-center gap-1">
          <div className="h-3 w-6 rounded bg-blue-500" /> 進捗
        </div>
        <div className="flex items-center gap-1">
          <div className="h-3 w-6 rounded bg-blue-200" /> 残り
        </div>
        <div className="flex items-center gap-1">
          <div className="h-3 w-6 rounded bg-red-500" /> 遅延
        </div>
        <div className="flex items-center gap-1">
          <div className="h-3 w-3 rotate-45 bg-purple-500" /> マイルストーン
        </div>
      </div>
    </div>
  );
}
