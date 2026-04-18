'use client';

import { useCallback, useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { filterTreeByAssignee, filterTreeByStatus, UNASSIGNED_KEY } from '@/lib/task-tree-utils';
import { TASK_STATUSES } from '@/types';
import type { TaskDTO } from '@/services/task.service';
import type { MemberDTO } from '@/services/member.service';
import { useSessionStringSet } from '@/lib/use-session-state';
import { MultiSelectFilter } from '@/components/multi-select-filter';

const ALL_STATUS_KEYS = Object.keys(TASK_STATUSES) as Array<keyof typeof TASK_STATUSES>;

type Props = {
  projectId: string;
  /**
   * WBS と同じ tree (`tasksData.tree`) を受け取り、ガントチャート側で階層を再帰描画する。
   */
  tasks: TaskDTO[];
  /** 担当者フィルタ候補（WBS と同仕様）*/
  members: MemberDTO[];
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

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

const DAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** 1日あたりの幅(px) */
const DAY_WIDTH = 32;
/** タスク列 (左固定) の幅(px) */
const NAME_COL_WIDTH = 280;
/** 月ヘッダ高さ(px) */
const MONTH_HEADER_H = 24;
/** 日ヘッダ高さ(px) */
const DAY_HEADER_H = 36;
/** チャート領域の高さ上限 — 長大な WBS でも表示域を固定し sticky が効くようにする */
const CHART_MAX_HEIGHT = 'calc(100vh - 240px)';

const statusColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  not_started: 'outline',
  in_progress: 'default',
  completed: 'secondary',
  on_hold: 'destructive',
};

type FlatRow = {
  task: TaskDTO;
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
};

/**
 * tree + 折りたたみ状態 から表示行を算出する。
 * 折りたたまれている WP 配下は再帰しない。
 */
function flattenForGantt(
  nodes: TaskDTO[],
  collapsed: Set<string>,
  depth = 0,
  out: FlatRow[] = [],
): FlatRow[] {
  for (const task of nodes) {
    const hasChildren = !!task.children && task.children.length > 0;
    const isCollapsed = collapsed.has(task.id);
    out.push({ task, depth, hasChildren, isCollapsed });
    if (hasChildren && !isCollapsed) {
      flattenForGantt(task.children!, collapsed, depth + 1, out);
    }
  }
  return out;
}

/** 日付レンジ文字列（未設定は "-"）*/
function rangeText(start: string | null | undefined, end: string | null | undefined): string {
  if (!start && !end) return '-';
  return `${start || '（未）'} 〜 ${end || '（未）'}`;
}

export function GanttClient({ projectId, tasks: tree, members }: Props) {
  const today = useMemo(() => new Date().toISOString().split('T')[0], []);

  // 折りたたみ状態 (PR #61: sessionStorage 永続化)。
  // セマンティクス: Set に含まれる ID = 「折りたたみ中」。
  // デフォルトは全 WP を折りたたむ (= WP ID 全件)。
  // sessionStorage に保存済み値があればそちらを優先 (セッション内の user 操作を尊重)。
  const [collapsed, setCollapsed] = useSessionStringSet(
    `gantt:${projectId}:collapsed`,
    () => {
      const ids: string[] = [];
      const walk = (nodes: TaskDTO[]) => {
        for (const n of nodes) {
          if (n.type === 'work_package') ids.push(n.id);
          if (n.children) walk(n.children);
        }
      };
      walk(tree);
      return ids;
    },
  );
  const toggleCollapsed = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // --- 担当者フィルタ (PR #61: sessionStorage 永続化) ---
  const allAssigneeKeys = useMemo<string[]>(
    () => [...members.map((m) => m.userId), UNASSIGNED_KEY],
    [members],
  );
  const [assigneeFilter, setAssigneeFilter] = useSessionStringSet(
    `gantt:${projectId}:assignee-filter`,
    () => allAssigneeKeys,
  );
  const isAllAssigneesSelected
    = assigneeFilter.size === allAssigneeKeys.length
    && allAssigneeKeys.every((k) => assigneeFilter.has(k));
  const toggleAssignee = useCallback((key: string) => {
    setAssigneeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [setAssigneeFilter]);
  const selectAllAssignees = useCallback(() => {
    setAssigneeFilter(() => new Set(allAssigneeKeys));
  }, [allAssigneeKeys, setAssigneeFilter]);
  const clearAllAssignees = useCallback(() => {
    setAssigneeFilter(() => new Set());
  }, [setAssigneeFilter]);

  // --- 状況フィルタ (PR #61) ---
  const [statusFilter, setStatusFilter] = useSessionStringSet(
    `gantt:${projectId}:status-filter`,
    () => [...ALL_STATUS_KEYS],
  );
  const isAllStatusesSelected
    = statusFilter.size === ALL_STATUS_KEYS.length
    && ALL_STATUS_KEYS.every((k) => statusFilter.has(k));
  const toggleStatus = useCallback((key: string) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [setStatusFilter]);
  const selectAllStatuses = useCallback(() => {
    setStatusFilter(() => new Set(ALL_STATUS_KEYS));
  }, [setStatusFilter]);
  const clearAllStatuses = useCallback(() => {
    setStatusFilter(() => new Set());
  }, [setStatusFilter]);

  const filteredTree = useMemo(() => {
    let t = tree;
    if (!isAllAssigneesSelected) t = filterTreeByAssignee(t, assigneeFilter);
    if (!isAllStatusesSelected) t = filterTreeByStatus(t, statusFilter);
    return t;
  }, [tree, assigneeFilter, isAllAssigneesSelected, statusFilter, isAllStatusesSelected]);

  const rows = useMemo(() => flattenForGantt(filteredTree, collapsed), [filteredTree, collapsed]);

  // チャートの期間レンジ: 全タスク（WP 集計含む）の予定・実績から求める
  const { minDate, totalDays } = useMemo(() => {
    const allDates: string[] = [];
    const walk = (nodes: TaskDTO[]) => {
      for (const t of nodes) {
        if (t.plannedStartDate) allDates.push(t.plannedStartDate);
        if (t.plannedEndDate) allDates.push(t.plannedEndDate);
        if (t.actualStartDate) allDates.push(t.actualStartDate);
        if (t.actualEndDate) allDates.push(t.actualEndDate);
        if (t.children) walk(t.children);
      }
    };
    walk(tree);
    if (allDates.length === 0) return { minDate: today, totalDays: 30 };
    const sorted = [...allDates].sort();
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    return { minDate: min, totalDays: Math.max(daysBetween(min, max) + 1, 7) };
  }, [tree, today]);

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

  const dayHeaders = useMemo(() => {
    const headers: { date: string; day: number; dayOfWeek: number }[] = [];
    const start = new Date(minDate);
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      headers.push({ date: formatDate(d), day: d.getDate(), dayOfWeek: d.getDay() });
    }
    return headers;
  }, [minDate, totalDays]);

  // 週末・今日の縦帯（行背景用・全行共通で 1 枚のオーバーレイ）
  const dayMarkers = useMemo(
    () =>
      dayHeaders
        .map((dh, index) => ({
          index,
          isWeekend: dh.dayOfWeek === 0 || dh.dayOfWeek === 6,
          isToday: dh.date === today,
        }))
        .filter((m) => m.isWeekend || m.isToday),
    [dayHeaders, today],
  );

  const chartWidth = totalDays * DAY_WIDTH;
  const totalWidth = NAME_COL_WIDTH + chartWidth;

  const hasAnyTask = tree.length > 0;

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">ガントチャート</h2>

      {/* フィルタ (担当者 + 状況、PR #61) */}
      <div className="flex flex-wrap items-center gap-2">
        <MultiSelectFilter
          label="担当者"
          options={[
            ...members.map((m) => ({ value: m.userId, label: m.userName })),
            { value: UNASSIGNED_KEY, label: '（未アサイン）', muted: true },
          ]}
          selected={assigneeFilter}
          onToggle={toggleAssignee}
          onSelectAll={selectAllAssignees}
          onClearAll={clearAllAssignees}
          isAllSelected={isAllAssigneesSelected}
          allLabel="全員"
        />
        <MultiSelectFilter
          label="状況"
          options={ALL_STATUS_KEYS.map((k) => ({ value: k, label: TASK_STATUSES[k] }))}
          selected={statusFilter}
          onToggle={toggleStatus}
          onSelectAll={selectAllStatuses}
          onClearAll={clearAllStatuses}
          isAllSelected={isAllStatusesSelected}
        />
        {(!isAllAssigneesSelected || !isAllStatusesSelected) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => { selectAllAssignees(); selectAllStatuses(); }}
          >
            フィルタ解除
          </Button>
        )}
      </div>

      {/* 凡例（上部配置・スクロールに影響されない）*/}
      <div className="flex flex-wrap items-center gap-4 text-xs text-gray-500">
        <div className="flex items-center gap-1">
          <div className="h-3 w-6 rounded bg-blue-200" /> 予定
        </div>
        <div className="flex items-center gap-1">
          <div className="h-3 w-6 rounded bg-blue-500" /> 実績 (進捗)
        </div>
        <div className="flex items-center gap-1">
          <div className="h-3 w-6 rounded bg-red-500" /> 遅延
        </div>
        <div className="flex items-center gap-1">
          <div className="h-3 w-3 rotate-45 bg-purple-500" /> マイルストーン
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="py-8 text-center text-gray-500">
          {hasAnyTask ? '選択した担当者に該当するタスクはありません' : 'タスクがありません'}
        </p>
      ) : (
      /*
        スクロールコンテナ:
          - 縦スクロール時は月・日ヘッダが sticky top で固定
          - 横スクロール時はタスク列が sticky left で固定
        sticky を効かせるため:
          - このコンテナが overflow: auto を持つスクロール主体
          - 内側要素に position: sticky を指定して top/left を与える
      */
      <div
        className="rounded-lg border overflow-auto relative"
        style={{ maxHeight: CHART_MAX_HEIGHT }}
      >
        <div style={{ width: `${totalWidth}px` }} className="relative">
          {/* ヘッダ: 月（最上段 sticky top:0） */}
          <div
            className="sticky top-0 z-20 flex border-b bg-gray-50"
            style={{ height: `${MONTH_HEADER_H}px` }}
          >
            {/* 左上コーナー（縦横両方向 sticky のため z-30） */}
            <div
              className="sticky left-0 z-30 shrink-0 border-r bg-gray-50"
              style={{ width: `${NAME_COL_WIDTH}px` }}
            />
            <div className="flex">
              {monthHeaders.map((mh, i) => (
                <div
                  key={i}
                  className="border-r px-1 text-center text-xs font-medium leading-6 text-gray-600"
                  style={{ width: `${mh.span * DAY_WIDTH}px` }}
                >
                  {mh.label}
                </div>
              ))}
            </div>
          </div>

          {/* ヘッダ: 日（2段目 sticky top:MONTH_HEADER_H） */}
          <div
            className="sticky z-20 flex border-b bg-gray-50"
            style={{ top: `${MONTH_HEADER_H}px`, height: `${DAY_HEADER_H}px` }}
          >
            <div
              className="sticky left-0 z-30 shrink-0 border-r bg-gray-50 px-3 text-xs font-medium leading-9"
              style={{ width: `${NAME_COL_WIDTH}px` }}
            >
              タスク名
            </div>
            <div className="flex">
              {dayHeaders.map((dh, i) => {
                const isWeekend = dh.dayOfWeek === 0 || dh.dayOfWeek === 6;
                const isToday = dh.date === today;
                return (
                  <div
                    key={i}
                    className={`border-r py-1 text-center text-[10px] leading-tight ${
                      isToday
                        ? 'bg-blue-100 font-bold text-blue-700'
                        : isWeekend
                          ? 'bg-gray-100 text-gray-400'
                          : 'text-gray-500'
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

          {/* ボディ: 各タスク行 */}
          <div className="relative">
            {/* 週末・今日背景（全タスク行共通・チャート領域のみ）*/}
            <div
              className="pointer-events-none absolute top-0 bottom-0 flex"
              style={{ left: `${NAME_COL_WIDTH}px`, width: `${chartWidth}px` }}
              aria-hidden
            >
              {dayMarkers.map((dm) => (
                <div
                  key={dm.index}
                  className={`absolute top-0 bottom-0 ${dm.isToday ? 'bg-blue-50' : 'bg-gray-50'}`}
                  style={{ left: `${dm.index * DAY_WIDTH}px`, width: `${DAY_WIDTH}px` }}
                />
              ))}
            </div>

            {rows.map(({ task, depth, hasChildren, isCollapsed }) => (
              <GanttRow
                key={task.id}
                task={task}
                depth={depth}
                hasChildren={hasChildren}
                isCollapsed={isCollapsed}
                minDate={minDate}
                chartWidth={chartWidth}
                today={today}
                onToggleCollapsed={toggleCollapsed}
              />
            ))}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

type GanttRowProps = {
  task: TaskDTO;
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
  minDate: string;
  chartWidth: number;
  today: string;
  onToggleCollapsed: (id: string) => void;
};

function GanttRow({
  task,
  depth,
  hasChildren,
  isCollapsed,
  minDate,
  chartWidth,
  today,
  onToggleCollapsed,
}: GanttRowProps) {
  const isWP = task.type === 'work_package';
  const hasPlanned = !!task.plannedStartDate && !!task.plannedEndDate;
  const hasActualStart = !!task.actualStartDate;
  // 実績終了が未設定でも、開始が入っていて未完了なら今日まで伸ばす（進行中の表現）
  const actualEffectiveEnd =
    task.actualEndDate || (task.actualStartDate && task.status !== 'not_started' ? today : null);

  const plannedBar = hasPlanned
    ? (() => {
        const offset = dayOffset(minDate, task.plannedStartDate!);
        const duration = daysBetween(task.plannedStartDate!, task.plannedEndDate!) + 1;
        return { left: offset * DAY_WIDTH, width: Math.max(duration * DAY_WIDTH, DAY_WIDTH) };
      })()
    : null;
  const actualBar =
    hasActualStart && actualEffectiveEnd
      ? (() => {
          const offset = dayOffset(minDate, task.actualStartDate!);
          const duration = daysBetween(task.actualStartDate!, actualEffectiveEnd) + 1;
          return { left: offset * DAY_WIDTH, width: Math.max(duration * DAY_WIDTH, DAY_WIDTH) };
        })()
      : null;

  const isDelayed =
    task.status !== 'completed' && task.plannedEndDate && task.plannedEndDate < today;

  // ツールチップは左タスク列に常時表示していない項目のみ（名称・担当者・ステータス・
  // 進捗は左列に出ているため重複表示しない）
  const tooltipContent = (
    <div className="space-y-0.5">
      <div>工数: {task.plannedEffort > 0 ? `${task.plannedEffort}h` : '-'}</div>
      <div>予定: {rangeText(task.plannedStartDate, task.plannedEndDate)}</div>
      <div>実績: {rangeText(task.actualStartDate, task.actualEndDate)}</div>
    </div>
  );

  return (
    <Tooltip content={tooltipContent} side="top" align="start">
      {/*
        行ハイライト + 今日縦帯の共存戦略:
        - ホバー背景は translucent (bg-blue-100/30) にし、背面の今日/週末オーバーレイが
          透けて見えるようにしている（不透明な hover 背景だと今日帯が隠れてしまう）。
        - 左側タスク列は sticky で自身の bg が必要だが、group-hover で tint を切り替え
          ハイライトを左右通しで一体感のあるものにする。
      */}
      <div
        className={`group relative flex border-b transition-colors hover:bg-blue-100/30 ${isWP ? 'bg-gray-50/50' : ''}`}
      >
        {/* 左側タスク列（sticky left）*/}
        <div
          className="sticky left-0 z-10 shrink-0 border-r bg-white px-2 py-2 transition-colors group-hover:bg-blue-50"
          style={{
            width: `${NAME_COL_WIDTH}px`,
            paddingLeft: `${depth * 16 + 8}px`,
          }}
        >
          <div className="flex items-center gap-1.5">
            {hasChildren ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleCollapsed(task.id);
                }}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-200"
                title={isCollapsed ? '展開' : '折りたたみ'}
                aria-label={isCollapsed ? '展開' : '折りたたみ'}
              >
                <span
                  className={`text-xs transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                >
                  ▶
                </span>
              </button>
            ) : (
              <span className="w-5 shrink-0" />
            )}
            <Badge variant={isWP ? 'default' : 'outline'} className="shrink-0 text-[10px] px-1.5 py-0">
              {isWP ? 'WP' : 'ACT'}
            </Badge>
            <span
              className={`truncate ${isWP ? 'font-semibold' : 'font-medium'} text-sm`}
              title={task.name}
            >
              {task.name}
            </span>
            {task.wbsNumber && (
              <span className="shrink-0 text-[10px] text-gray-400">{task.wbsNumber}</span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 pl-[26px]">
            <Badge variant={statusColors[task.status] || 'outline'} className="text-[10px] px-1 py-0">
              {TASK_STATUSES[task.status as keyof typeof TASK_STATUSES] || task.status}
            </Badge>
            <span className="text-[10px] text-gray-500">{task.progressRate}%</span>
            {task.assigneeName && (
              <span className="truncate text-[10px] text-gray-400">{task.assigneeName}</span>
            )}
          </div>
        </div>

        {/* バー領域 */}
        <div className="relative" style={{ width: `${chartWidth}px`, minHeight: '44px' }}>
          {task.isMilestone && plannedBar ? (
            <div
              className="absolute top-3 flex h-6 items-center justify-center"
              style={{ left: `${plannedBar.left}px`, width: `${DAY_WIDTH}px` }}
            >
              <div className="h-3 w-3 rotate-45 bg-purple-500" />
            </div>
          ) : (
            <>
              {/* 予定バー (薄色) */}
              {plannedBar && (
                <div
                  className={`absolute top-2 h-3 rounded ${
                    isDelayed ? 'bg-red-200' : 'bg-blue-200'
                  }`}
                  style={{ left: `${plannedBar.left}px`, width: `${plannedBar.width}px` }}
                />
              )}
              {/* 実績バー (濃色・進捗) */}
              {actualBar && (
                <div
                  className={`absolute top-6 h-3 rounded ${
                    isDelayed ? 'bg-red-500' : 'bg-blue-500'
                  }`}
                  style={{ left: `${actualBar.left}px`, width: `${actualBar.width}px` }}
                >
                  {task.progressRate > 0 && task.progressRate < 100 && (
                    <div
                      className="h-3 rounded-l bg-blue-700"
                      style={{ width: `${task.progressRate}%` }}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Tooltip>
  );
}
