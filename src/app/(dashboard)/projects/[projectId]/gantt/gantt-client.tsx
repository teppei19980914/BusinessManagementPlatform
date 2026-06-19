'use client';

/**
 * ガントチャート画面のクライアントコンポーネント。
 *
 * 役割:
 *   タスクを時系列でバー描画する。マイルストーン (ダイヤ型 / bg-milestone-marker) と
 *   通常タスクを区別。担当者フィルタ + 完了タスク表示切替などのコントロール付き。
 *
 * レイアウト定数 (本ファイル冒頭で定義):
 *   - DAY_WIDTH = 32       1 日のピクセル幅
 *   - NAME_COL_DEFAULT_WIDTH = 280  タスク名列の初期幅 (PR #68 でドラッグ可変対応)
 *   - MONTH_HEADER_H / DAY_HEADER_H ヘッダ行の高さ
 *   これらは単一コンポーネント内のみで使うため §21.4.4 に従い外出し対象外。
 *
 * パフォーマンス (PR #25):
 *   - 背景グリッドは行ごとではなく container 全体に 1 回だけ描画 (CSS background)
 *   - useMemo でタスク → バー位置のマッピングをキャッシュ
 *
 * 認可: ページ側でメンバーシップ確認済 (read 権限)。
 * API: /api/projects/[id]/gantt
 *
 * 関連:
 *   - SPECIFICATION.md (ガントチャート画面)
 *   - DESIGN.md §15 (idx_tasks_gantt インデックス)
 *   - PR #68 (列幅ドラッグリサイズ)
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { filterTreeByAssignee, filterTreeByStatus, flattenActivities, taskStatusColors, UNASSIGNED_KEY } from '@/lib/task-tree-utils';
import { TASK_STATUSES } from '@/types';
import type { TaskDTO } from '@/services/task.service';
import type { MemberDTO } from '@/services/member.service';
import { useSessionState, useSessionStringSet } from '@/lib/use-session-state';
import { MultiSelectFilter } from '@/components/multi-select-filter';
// PR #125: 日本の祝日を Gantt ヘッダ / 背景に反映 (土日と同等の視覚扱い + 祝日名ツールチップ)
import { getJapaneseHoliday } from '@/lib/jp-holidays';
// feat/gantt-initial-scroll-and-locale: 月ヘッダの locale 表示用に Intl.DateTimeFormat を直接構築する
//   (formatDate は dd を含むため、年月のみのヘッダ向けに専用フォーマッタを使う)
// tooltip の予定/実績期間も WBS テーブルと表示形式を揃えるため formatDateOnly を使う
import { useFormatters } from '@/lib/use-formatters';

const ALL_STATUS_KEYS = Object.keys(TASK_STATUSES) as Array<keyof typeof TASK_STATUSES>;

/** 表示切替チップ (ガント表示 / 担当者別確認)。analysis タブの複数選択チップと同方式で両方同時表示できる。 */
const VIEW_OPTIONS: { key: string; labelKey: string }[] = [
  { key: 'chart', labelKey: 'viewChartLabel' },
  { key: 'board', labelKey: 'viewBoardLabel' },
];

/** 担当者別確認ボードの対象ウィンドウ (today を基準に前後 N 日)。 */
const BOARD_WINDOW_DAYS = 3;

type BoardAssigneeGroup = {
  assigneeKey: string;
  assigneeName: string;
  done: TaskDTO[];
  inProgress: TaskDTO[];
  upcoming: TaskDTO[];
  onHold: TaskDTO[];
};

/** 予定終了日を過ぎても未完了 (進行中 or 未着手) なタスクを遅延として強調する。バー描画の isDelayed と同じ定義。 */
function isTaskAnomalous(task: TaskDTO, today: string): boolean {
  return (
    task.status !== 'completed'
    && task.status !== 'on_hold'
    && !!task.plannedEndDate
    && task.plannedEndDate < today
  );
}

type Props = {
  projectId: string;
  /**
   * WBS と同じ tree (`tasksData.tree`) を受け取り、ガントチャート側で階層を再帰描画する。
   */
  tasks: TaskDTO[];
  /** 担当者フィルタ候補（WBS と同仕様）*/
  members: MemberDTO[];
  /**
   * feat/gantt-initial-scroll-and-locale: server で算出した tenant TZ ベースの「今日」(YYYY-MM-DD)。
   * client 側で `new Date()` を呼ばず、SSR/CSR 一致と UTC ズレ回避を担保する。
   */
  today: string;
  /** Tenant TZ (IANA、ヘッダ表示や日付境界判定に使用) */
  tenantTimeZone: string;
  /** Tenant locale (BCP 47、月ヘッダの言語表記切替に使用) */
  tenantLocale: string;
  /** マイタスク等のプロジェクト横断ビューでは担当者別確認ボードを非表示にする (プロジェクト単位の機能) */
  hideBoard?: boolean;
};

/**
 * 'YYYY-MM-DD' を UTC midnight として解釈し、ミリ秒値に変換する。
 *
 * feat/gantt-initial-scroll-and-locale (2026-05-29): ガント内の日付計算は全て
 * 「カレンダー日 (YYYY-MM-DD)」ベースで行う。
 * `new Date('2026-04-15')` は brower TZ 影響でズレるため、明示的に UTC 0:00 として
 * 解釈する `Date.parse(\`${iso}T00:00:00Z\`)` を使う。
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isoToUtcMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

function daysBetween(start: string, end: string): number {
  return Math.round((isoToUtcMs(end) - isoToUtcMs(start)) / MS_PER_DAY);
}

function dayOffset(base: string, date: string): number {
  return Math.round((isoToUtcMs(date) - isoToUtcMs(base)) / MS_PER_DAY);
}

/** 'YYYY-MM-DD' に N 日加算した 'YYYY-MM-DD' を返す (TZ 非依存) */
function addDaysISO(base: string, days: number): string {
  return new Date(isoToUtcMs(base) + days * MS_PER_DAY).toISOString().split('T')[0];
}

/** 'YYYY-MM-DD' の曜日 (0=Sun..6=Sat) を返す (UTC 解釈で TZ 非依存) */
function dayOfWeekISO(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/** 'YYYY-MM-DD' から day-of-month (1-31) を返す */
function dayOfMonthISO(iso: string): number {
  return Number(iso.slice(8, 10));
}

/** 'YYYY-MM' (年月) を抽出する */
function yearMonthISO(iso: string): string {
  return iso.slice(0, 7);
}

const DAY_LABEL_KEYS = [
  'dayLabelSun',
  'dayLabelMon',
  'dayLabelTue',
  'dayLabelWed',
  'dayLabelThu',
  'dayLabelFri',
  'dayLabelSat',
] as const;

/** 1日あたりの幅(px) */
const DAY_WIDTH = 32;
/** タスク列 (左固定) の幅(px) — ユーザが PR #68 でドラッグ変更可能 */
const NAME_COL_DEFAULT_WIDTH = 280;
const NAME_COL_MIN_WIDTH = 120;
const NAME_COL_MAX_WIDTH = 800;
/** 月ヘッダ高さ(px) */
const MONTH_HEADER_H = 24;
/** 日ヘッダ高さ(px) */
const DAY_HEADER_H = 36;
/** チャート領域の高さ上限 — 長大な WBS でも表示域を固定し sticky が効くようにする */
const CHART_MAX_HEIGHT = 'calc(100vh - 240px)';

// 旧ローカル statusColors は lib/task-tree-utils.ts の taskStatusColors に集約 (PR #63 DRY)
const statusColors = taskStatusColors;

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

/**
 * 日付レンジ文字列（未設定は "-"）
 * unsetLabel は i18n 化された「(未)」相当のローカライズ済み文字列を渡す。
 *
 * feat/gantt-initial-scroll-and-locale (2026-05-29):
 *   format は YYYY-MM-DD → locale 表示に変換する関数 (useFormatters の formatDateOnly)。
 *   WBS テーブル ([tasks-client.tsx]) と表示形式を統一する。
 */
function rangeText(
  start: string | null | undefined,
  end: string | null | undefined,
  unsetLabel: string,
  format: (ymd: string) => string,
): string {
  if (!start && !end) return '-';
  return `${format(start ?? '') || unsetLabel} 〜 ${format(end ?? '') || unsetLabel}`;
}

export function GanttClient({
  projectId,
  tasks: tree,
  members,
  today,
  tenantTimeZone,
  tenantLocale,
  hideBoard = false,
}: Props) {
  const t = useTranslations('gantt');
  // feat/gantt-initial-scroll-and-locale: 月ヘッダは Intl.DateTimeFormat で tenant locale 直接生成
  //   (ja-JP → "2026年5月"、en-US → "May 2026")。旧 i18n key 'monthHeader' は素朴連結 ("{year}/{month}")
  //   で locale 自然性が低かったため撤去。messages/{ja,en-US}.json からも monthHeader を削除済。
  const monthHeaderFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(tenantLocale, {
        timeZone: tenantTimeZone,
        year: 'numeric',
        month: 'long',
      }),
    [tenantLocale, tenantTimeZone],
  );

  // PR #68: ガントのタスク名列幅をユーザが調整可能にする (sessionStorage 永続)。
  // チャート本体 (日付列) は固定 DAY_WIDTH で変更しない。
  const [nameColWidth, setNameColWidth] = useSessionState<number>(
    `gantt:${projectId}:name-col-width`,
    NAME_COL_DEFAULT_WIDTH,
  );
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onNameColDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStartRef.current = { startX: e.clientX, startWidth: nameColWidth };
    const onMove = (ev: MouseEvent) => {
      if (!dragStartRef.current) return;
      const delta = ev.clientX - dragStartRef.current.startX;
      const next = Math.max(
        NAME_COL_MIN_WIDTH,
        Math.min(NAME_COL_MAX_WIDTH, dragStartRef.current.startWidth + delta),
      );
      setNameColWidth(next);
    };
    const onUp = () => {
      dragStartRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [nameColWidth, setNameColWidth]);
  const resetNameColWidth = useCallback(() => {
    setNameColWidth(NAME_COL_DEFAULT_WIDTH);
  }, [setNameColWidth]);

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

  // --- 表示切替 (ガント表示 / 担当者別確認) ---
  const [visibleViews, setVisibleViews] = useSessionState<string[]>(
    `gantt:${projectId}:visible-views`,
    () => ['chart', 'board'],
  );
  const toggleView = useCallback((key: string) => {
    setVisibleViews((prev) => (prev.includes(key) ? prev.filter((v) => v !== key) : [...prev, key]));
  }, [setVisibleViews]);

  // --- 担当者別確認ボード: today ± BOARD_WINDOW_DAYS の ACT を担当者ごとに
  //     終わった/やっている/これから/保留 に分類する。担当者フィルタのみ尊重し、
  //     状況フィルタは無視する (ボード自身が status × 日付で分類するため)。
  const progressBoardGroups = useMemo<BoardAssigneeGroup[]>(() => {
    const activities = flattenActivities(tree).filter((task) => {
      const key = task.assigneeId ?? UNASSIGNED_KEY;
      return isAllAssigneesSelected || assigneeFilter.has(key);
    });
    const windowStart = addDaysISO(today, -BOARD_WINDOW_DAYS);
    const windowEnd = addDaysISO(today, BOARD_WINDOW_DAYS);
    const groups = new Map<string, BoardAssigneeGroup>();
    const groupFor = (task: TaskDTO) => {
      const key = task.assigneeId ?? UNASSIGNED_KEY;
      let group = groups.get(key);
      if (!group) {
        group = {
          assigneeKey: key,
          assigneeName: task.assigneeDisplayText || task.assigneeName || t('unassigned'),
          done: [],
          inProgress: [],
          upcoming: [],
          onHold: [],
        };
        groups.set(key, group);
      }
      return group;
    };
    for (const task of activities) {
      if (task.status === 'on_hold') {
        groupFor(task).onHold.push(task);
      } else if (task.status === 'completed') {
        const completedOn = task.actualEndDate || task.plannedEndDate;
        if (completedOn && completedOn >= windowStart && completedOn <= windowEnd) {
          groupFor(task).done.push(task);
        }
      } else if (task.status === 'in_progress') {
        groupFor(task).inProgress.push(task);
      } else if (!task.plannedStartDate || task.plannedStartDate <= windowEnd) {
        groupFor(task).upcoming.push(task);
      }
    }
    return [...groups.values()].sort((a, b) => a.assigneeName.localeCompare(b.assigneeName, tenantLocale));
  }, [tree, assigneeFilter, isAllAssigneesSelected, today, tenantLocale, t]);

  const filteredTree = useMemo(() => {
    let t = tree;
    if (!isAllAssigneesSelected) t = filterTreeByAssignee(t, assigneeFilter);
    if (!isAllStatusesSelected) t = filterTreeByStatus(t, statusFilter);
    return t;
  }, [tree, assigneeFilter, isAllAssigneesSelected, statusFilter, isAllStatusesSelected]);

  const rows = useMemo(() => flattenForGantt(filteredTree, collapsed), [filteredTree, collapsed]);

  // チャートの期間レンジ: 全タスク（WP 集計含む）の予定・実績 + today を含めて算出
  // feat/gantt-initial-scroll-and-locale: 「今日」を必ず表示レンジ内に含めることで、
  //   初期スクロール (scrollLeft = dayOffset(minDate, today) * DAY_WIDTH) が常に正の値となり、
  //   today が viewport 左端から見えるようにする。
  //   また「タスクが今日より遥か未来」「全タスクが今日より過去」のケースで today マーカーが
  //   レンジ外に消えるのを防ぐ。
  const { minDate, totalDays } = useMemo(() => {
    const allDates: string[] = [today];
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
    const sorted = [...allDates].sort();
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    return { minDate: min, totalDays: Math.max(daysBetween(min, max) + 1, 30) };
  }, [tree, today]);

  // feat/gantt-initial-scroll-and-locale: 月ヘッダは tenant locale の DateTimeFormat で生成
  //   (ja-JP → "2026年5月"、en-US → "May 2026")。
  //   旧来の i18n key 'monthHeader' は "{year}/{month}" の素朴連結だったため locale 自然性が低かった。
  const monthHeaders = useMemo(() => {
    const headers: { label: string; span: number }[] = [];
    let currentYearMonth = '';
    for (let i = 0; i < totalDays; i++) {
      const iso = addDaysISO(minDate, i);
      const ym = yearMonthISO(iso);
      if (ym !== currentYearMonth) {
        // iso = 'YYYY-MM-DD'。月初を表す Date を UTC noon で構築し、
        // tenantTimeZone での解釈ズレ (日付境界跨ぎ) を回避する。
        const monthStart = new Date(`${ym}-01T12:00:00Z`);
        headers.push({ label: monthHeaderFormatter.format(monthStart), span: 1 });
        currentYearMonth = ym;
      } else {
        headers[headers.length - 1].span++;
      }
    }
    return headers;
  }, [minDate, totalDays, monthHeaderFormatter]);

  const dayHeaders = useMemo(() => {
    const headers: {
      date: string;
      day: number;
      dayOfWeek: number;
      // PR #125: 祝日なら名称、そうでなければ null
      holidayName: string | null;
    }[] = [];
    for (let i = 0; i < totalDays; i++) {
      const iso = addDaysISO(minDate, i);
      headers.push({
        date: iso,
        day: dayOfMonthISO(iso),
        dayOfWeek: dayOfWeekISO(iso),
        holidayName: getJapaneseHoliday(iso),
      });
    }
    return headers;
  }, [minDate, totalDays]);

  // 週末・祝日・今日の縦帯（行背景用・全行共通で 1 枚のオーバーレイ）
  // PR #125 + Phase C 要件 16/17 (2026-04-28): 土曜=青、日曜・祝日=赤、今日=情報色 で色分け。
  const dayMarkers = useMemo(
    () =>
      dayHeaders
        .map((dh, index) => ({
          index,
          isSaturday: dh.dayOfWeek === 6,
          isSunday: dh.dayOfWeek === 0,
          isHoliday: dh.holidayName !== null,
          isToday: dh.date === today,
        }))
        .filter((m) => m.isSaturday || m.isSunday || m.isHoliday || m.isToday),
    [dayHeaders, today],
  );

  const chartWidth = totalDays * DAY_WIDTH;
  const totalWidth = nameColWidth + chartWidth;

  const hasAnyTask = tree.length > 0;

  // feat/gantt-initial-scroll-and-locale: 初期スクロール位置を「今日」列が左端になるよう揃える。
  //   ユーザは画面を開いた瞬間に進行中タスクの状況を確認できる (毎回今日へスクロールし直す手間を撲滅)。
  //   依存配列を [projectId, today] に限定: filter/折りたたみ変更時にユーザのスクロール操作を
  //   上書きしないようにする。projectId 変更時 (別プロジェクト遷移) は再初期化。
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const todayOffset = dayOffset(minDate, today);
    if (todayOffset < 0) return; // today がレンジ外 (minDate に today を含めているので理論上発生しない)
    // タスク名列 (sticky left) はチャートのスクロール座標上は不変なので除外。
    // scrollLeft = 今日列の left = todayOffset * DAY_WIDTH。
    el.scrollLeft = todayOffset * DAY_WIDTH;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, today]);

  return (
    <div className="space-y-4">
      {/* 表示切替 (ガント表示 / 担当者別確認)。hideBoard=true のマイタスク等では非表示 */}
      {!hideBoard && (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{t('viewToggleLabel')}</span>
        {VIEW_OPTIONS.map((opt) => {
          const on = visibleViews.includes(opt.key);
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => toggleView(opt.key)}
              aria-pressed={on}
              className={
                on
                  ? 'rounded-full border border-foreground bg-foreground px-3 py-1 text-xs font-medium text-background'
                  : 'rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground hover:bg-accent'
              }
            >
              {t(opt.labelKey)}
            </button>
          );
        })}
      </div>
      )}

      {visibleViews.includes('chart') && (
      <div className="space-y-4">
      {/* Phase A 要件 6: h2 ページタイトル削除 (タブ名と重複のため) */}
      <div className="flex items-center justify-end">
        {/* PR #68: タスク名列の幅リセット (日付列は固定) */}
        <Button variant="outline" size="sm" onClick={resetNameColWidth}>
          {t('resetNameColWidth')}
        </Button>
      </div>

      {/* フィルタ (担当者 + 状況、PR #61) */}
      <div className="flex flex-wrap items-center gap-2">
        <MultiSelectFilter
          label={t('assignee')}
          options={[
            ...members.map((m) => ({ value: m.userId, label: m.userName })),
            { value: UNASSIGNED_KEY, label: t('unassigned'), muted: true },
          ]}
          selected={assigneeFilter}
          onToggle={toggleAssignee}
          onSelectAll={selectAllAssignees}
          onClearAll={clearAllAssignees}
          isAllSelected={isAllAssigneesSelected}
          allLabel={t('allAssignees')}
        />
        <MultiSelectFilter
          label={t('status')}
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
            {t('filterClear')}
          </Button>
        )}
      </div>

      {/* 凡例（上部配置・スクロールに影響されない）*/}
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <div className="h-3 w-6 rounded bg-info/30" /> {t('legendPlanned')}
        </div>
        <div className="flex items-center gap-1">
          <div className="h-3 w-6 rounded bg-info" /> {t('legendActual')}
        </div>
        <div className="flex items-center gap-1">
          <div className="h-3 w-6 rounded bg-destructive" /> {t('legendDelayed')}
        </div>
        <div className="flex items-center gap-1">
          <div className="h-3 w-3 rotate-45 bg-milestone-marker" /> {t('legendMilestone')}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">
          {hasAnyTask ? t('noTasksFiltered') : t('noTasks')}
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
        ref={scrollContainerRef}
        className="rounded-lg border overflow-auto relative"
        style={{ maxHeight: CHART_MAX_HEIGHT }}
      >
        <div style={{ width: `${totalWidth}px` }} className="relative">
          {/* ヘッダ: 月（最上段 sticky top:0） */}
          <div
            className="sticky top-0 z-20 flex border-b bg-muted"
            style={{ height: `${MONTH_HEADER_H}px` }}
          >
            {/* 左上コーナー（縦横両方向 sticky のため z-30） */}
            <div
              className="sticky left-0 z-30 shrink-0 border-r bg-muted"
              style={{ width: `${nameColWidth}px` }}
            />
            <div className="flex">
              {monthHeaders.map((mh, i) => (
                <div
                  key={i}
                  className="border-r px-1 text-center text-xs font-medium leading-6 text-muted-foreground"
                  style={{ width: `${mh.span * DAY_WIDTH}px` }}
                >
                  {mh.label}
                </div>
              ))}
            </div>
          </div>

          {/* ヘッダ: 日（2段目 sticky top:MONTH_HEADER_H） */}
          <div
            className="sticky z-20 flex border-b bg-muted"
            style={{ top: `${MONTH_HEADER_H}px`, height: `${DAY_HEADER_H}px` }}
          >
            <div
              className="sticky left-0 z-30 shrink-0 border-r bg-muted px-3 text-xs font-medium leading-9 relative"
              style={{ width: `${nameColWidth}px` }}
            >
              {t('taskNameColumn')}
              {/* PR #68: タスク名列の右端ドラッグハンドル (日付列は固定) */}
              <div
                onMouseDown={onNameColDragStart}
                className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-info/40 active:bg-info"
                role="separator"
                aria-orientation="vertical"
                aria-label={t('nameColResizeAria')}
              />
            </div>
            <div className="flex">
              {dayHeaders.map((dh, i) => {
                const isSaturday = dh.dayOfWeek === 6;
                const isSunday = dh.dayOfWeek === 0;
                const isToday = dh.date === today;
                // PR #125 + Phase C 要件 16 (2026-04-28): 祝日は日曜と同じ赤色扱い。
                //   祝日名は title 属性で tooltip 表示。
                const isHoliday = dh.holidayName !== null;
                // Phase C 要件 17 (2026-04-28): 土曜は青、日曜・祝日は赤に色分け
                const dayClass = isToday
                  ? 'bg-info/20 font-bold text-info'
                  : isSunday || isHoliday
                    ? 'bg-destructive/5 text-destructive'
                    : isSaturday
                      ? 'bg-info/5 text-info'
                      : 'text-muted-foreground';
                return (
                  <div
                    key={i}
                    // title で祝日名をネイティブ tooltip 表示 (hover でマウスオーバー検出)
                    title={dh.holidayName ?? undefined}
                    className={`border-r py-1 text-center text-[10px] leading-tight ${dayClass}`}
                    style={{ width: `${DAY_WIDTH}px` }}
                  >
                    <div>{dh.day}</div>
                    <div>{t(DAY_LABEL_KEYS[dh.dayOfWeek])}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ボディ: 各タスク行 */}
          <div className="relative">
            {/* 週末・祝日 (PR #125) ・今日背景（全タスク行共通・チャート領域のみ）*/}
            <div
              className="pointer-events-none absolute top-0 bottom-0 flex"
              style={{ left: `${nameColWidth}px`, width: `${chartWidth}px` }}
              aria-hidden
            >
              {dayMarkers.map((dm) => {
                // 優先順: today > 日曜・祝日 > 土曜
                const bgClass = dm.isToday
                  ? 'bg-info/10'
                  : dm.isSunday || dm.isHoliday
                    ? 'bg-destructive/5'
                    : dm.isSaturday
                      ? 'bg-info/5'
                      : 'bg-muted';
                return (
                  <div
                    key={dm.index}
                    className={`absolute top-0 bottom-0 ${bgClass}`}
                    style={{ left: `${dm.index * DAY_WIDTH}px`, width: `${DAY_WIDTH}px` }}
                  />
                );
              })}
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
                nameColWidth={nameColWidth}
                today={today}
                onToggleCollapsed={toggleCollapsed}
              />
            ))}
          </div>
        </div>
      </div>
      )}
      </div>
      )}

      {!hideBoard && visibleViews.includes('board') && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {t('boardWindowNote', { days: BOARD_WINDOW_DAYS })}
          </p>
          {progressBoardGroups.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">{t('boardNoAssignees')}</p>
          ) : (
            <div className="space-y-3">
              {progressBoardGroups.map((group) => (
                <ProgressBoardCard key={group.assigneeKey} group={group} today={today} />
              ))}
            </div>
          )}
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
  /** PR #68: 親から渡されるタスク名列幅 (ユーザがドラッグで変更可能) */
  nameColWidth: number;
  today: string;
  onToggleCollapsed: (id: string) => void;
};

function GanttRow({
  task,
  depth,
  hasChildren,
  isCollapsed,
  minDate,
  nameColWidth,
  chartWidth,
  today,
  onToggleCollapsed,
}: GanttRowProps) {
  const t = useTranslations('gantt');
  const { formatDateOnly } = useFormatters();
  const unsetLabel = t('unsetShort');
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
      <div>{t('tooltipEffort', { value: task.plannedEffort > 0 ? `${task.plannedEffort}h` : '-' })}</div>
      <div>{t('tooltipPlanned', { value: rangeText(task.plannedStartDate, task.plannedEndDate, unsetLabel, formatDateOnly) })}</div>
      <div>{t('tooltipActual', { value: rangeText(task.actualStartDate, task.actualEndDate, unsetLabel, formatDateOnly) })}</div>
    </div>
  );

  return (
    <Tooltip content={tooltipContent} side="top" align="start">
      {/*
        行ハイライト + 今日縦帯の共存戦略:
        - ホバー背景は translucent (bg-info/20/30) にし、背面の今日/週末オーバーレイが
          透けて見えるようにしている（不透明な hover 背景だと今日帯が隠れてしまう）。
        - 左側タスク列は sticky で自身の bg が必要だが、group-hover で tint を切り替え
          ハイライトを左右通しで一体感のあるものにする。
      */}
      <div
        className={`group relative flex border-b transition-colors hover:bg-info/20/30 ${isWP ? 'bg-muted/50' : ''}`}
      >
        {/* 左側タスク列（sticky left）*/}
        <div
          className="sticky left-0 z-10 shrink-0 border-r bg-card px-2 py-2 transition-colors group-hover:bg-info/10"
          style={{
            width: `${nameColWidth}px`,
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
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                title={isCollapsed ? t('expand') : t('collapse')}
                aria-label={isCollapsed ? t('expand') : t('collapse')}
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
              <span className="shrink-0 text-[10px] text-muted-foreground">{task.wbsNumber}</span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 pl-[26px]">
            <Badge variant={statusColors[task.status] || 'outline'} className="text-[10px] px-1 py-0">
              {TASK_STATUSES[task.status as keyof typeof TASK_STATUSES] || task.status}
            </Badge>
            <span className="text-[10px] text-muted-foreground">{task.progressRate}%</span>
            {(task.assigneeDisplayText || task.assigneeName) && (
              <span className="truncate text-[10px] text-muted-foreground">{task.assigneeDisplayText || task.assigneeName}</span>
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
              <div className="h-3 w-3 rotate-45 bg-milestone-marker" />
            </div>
          ) : (
            <>
              {/* 予定バー (薄色) */}
              {plannedBar && (
                <div
                  className={`absolute top-2 h-3 rounded ${
                    isDelayed ? 'bg-destructive/30' : 'bg-info/30'
                  }`}
                  style={{ left: `${plannedBar.left}px`, width: `${plannedBar.width}px` }}
                />
              )}
              {/* 実績バー (濃色・進捗) */}
              {actualBar && (
                <div
                  className={`absolute top-6 h-3 rounded ${
                    isDelayed ? 'bg-destructive' : 'bg-info'
                  }`}
                  style={{ left: `${actualBar.left}px`, width: `${actualBar.width}px` }}
                >
                  {task.progressRate > 0 && task.progressRate < 100 && (
                    <div
                      className="h-3 rounded-l bg-info"
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

const BOARD_COLUMNS: { key: keyof Omit<BoardAssigneeGroup, 'assigneeKey' | 'assigneeName'>; labelKey: string }[] = [
  { key: 'done', labelKey: 'boardColumnDone' },
  { key: 'inProgress', labelKey: 'boardColumnInProgress' },
  { key: 'upcoming', labelKey: 'boardColumnUpcoming' },
  { key: 'onHold', labelKey: 'boardColumnOnHold' },
];

type ProgressBoardCardProps = {
  group: BoardAssigneeGroup;
  today: string;
};

/**
 * 担当者 1 名分のカード。終わった/やっている/これから/保留 の 4 列で構成する。
 * 進行中・これから の列で予定終了日を過ぎているタスクは「遅延」バッジで強調する
 * (PM がヒアリング時に何を聞けばいいか一目で分かるようにするための core 機能)。
 */
function ProgressBoardCard({ group, today }: ProgressBoardCardProps) {
  const t = useTranslations('gantt');
  const { formatDateOnly } = useFormatters();

  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 text-sm font-semibold">{group.assigneeName}</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        {BOARD_COLUMNS.map((col) => {
          const tasks = group[col.key];
          return (
            <div key={col.key} className="space-y-1.5">
              <div className="text-[11px] font-medium text-muted-foreground">{t(col.labelKey)}</div>
              {tasks.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/70">{t('boardColumnEmpty')}</p>
              ) : (
                tasks.map((task) => {
                  const anomalous = col.key !== 'done' && col.key !== 'onHold' && isTaskAnomalous(task, today);
                  return (
                    <div key={task.id} className="rounded border bg-card px-2 py-1.5 text-xs">
                      <div className="flex items-center gap-1">
                        <span className="truncate font-medium" title={task.name}>
                          {task.name}
                        </span>
                        {anomalous && (
                          <Badge variant="destructive" className="shrink-0 px-1 py-0 text-[10px]">
                            {t('legendDelayed')}
                          </Badge>
                        )}
                      </div>
                      {task.plannedEndDate && (
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          {formatDateOnly(task.plannedEndDate)}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
