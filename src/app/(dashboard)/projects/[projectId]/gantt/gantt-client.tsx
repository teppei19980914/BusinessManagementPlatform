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

export function GanttClient({ tasks }: Props) {
  const { minDate, maxDate, totalDays } = useMemo(() => {
    if (tasks.length === 0) {
      const today = new Date().toISOString().split('T')[0];
      return { minDate: today, maxDate: today, totalDays: 30 };
    }
    const starts = tasks.map((t) => t.plannedStartDate);
    const ends = tasks.map((t) => t.plannedEndDate);
    const min = starts.sort()[0];
    const max = ends.sort().reverse()[0];
    return { minDate: min, maxDate: max, totalDays: Math.max(daysBetween(min, max) + 1, 7) };
  }, [tasks]);

  // 週単位のヘッダー生成
  const weekHeaders = useMemo(() => {
    const headers: { label: string; days: number }[] = [];
    const start = new Date(minDate);
    const current = new Date(start);
    const end = new Date(maxDate);

    while (current <= end) {
      const weekStart = new Date(current);
      const weekEnd = new Date(current);
      weekEnd.setDate(weekEnd.getDate() + 6);
      const actualEnd = weekEnd > end ? end : weekEnd;
      const days = daysBetween(weekStart.toISOString().split('T')[0], actualEnd.toISOString().split('T')[0]) + 1;
      headers.push({
        label: `${weekStart.getMonth() + 1}/${weekStart.getDate()}`,
        days,
      });
      current.setDate(current.getDate() + 7);
    }
    return headers;
  }, [minDate, maxDate]);

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
        <div className="min-w-[800px]">
          {/* ヘッダー */}
          <div className="flex border-b bg-gray-50">
            <div className="w-52 shrink-0 border-r px-3 py-2 text-xs font-medium">タスク名</div>
            <div className="flex flex-1">
              {weekHeaders.map((wh, i) => (
                <div
                  key={i}
                  className="border-r px-1 py-2 text-center text-xs text-gray-500"
                  style={{ width: `${(wh.days / totalDays) * 100}%` }}
                >
                  {wh.label}
                </div>
              ))}
            </div>
          </div>

          {/* タスク行 */}
          {tasks.map((task) => {
            const offset = dayOffset(minDate, task.plannedStartDate);
            const duration = daysBetween(task.plannedStartDate, task.plannedEndDate) + 1;
            const leftPercent = (offset / totalDays) * 100;
            const widthPercent = (duration / totalDays) * 100;
            const isDelayed = task.status !== 'completed' && new Date(task.plannedEndDate) < new Date();

            return (
              <div key={task.id} className="flex border-b hover:bg-gray-50">
                <div className="w-52 shrink-0 border-r px-3 py-2">
                  <div className="truncate text-sm font-medium">{task.name}</div>
                  <div className="text-xs text-gray-400">{task.assigneeName}</div>
                </div>
                <div className="relative flex-1 py-2">
                  <div
                    className="absolute top-2 h-6 rounded"
                    style={{
                      left: `${leftPercent}%`,
                      width: `${Math.max(widthPercent, 1)}%`,
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
