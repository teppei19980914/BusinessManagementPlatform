/**
 * 分析パネル レジストリ (分析タブ基盤)
 *
 * 役割:
 *   分析タブに並べる「パネル」を宣言的に定義する。1 パネル = 1 グラフ。
 *   各パネルは「API から raw を取得する load」と「raw + i18n ラベル → 描画データ build」を持つ。
 *   分析を増やすときは、ここに 1 パネル定義を足すだけでよい (タブ・チャート部品は無改修)。
 *
 * 設計方針 (汎用分析タブ基盤):
 *   - API/サービスはドメイン数値のみ返す (analytics.service.ts)。
 *   - 表示 (色・線種・ラベル・参照線) はこの build で組み立てる。
 *   - チャート部品 (TimeSeriesChart) は AnalysisChart 契約のみ知る。
 */

import type { AnalysisChart, AnalysisHeatmap } from '@/components/charts/types';
import type {
  WbsCompletionResult,
  AssigneeWeeklyEffortResult,
  AssigneeEffortVarianceResult,
  AssigneeWorkloadResult,
  AssigneeDailyCapacityResult,
  AnalyticsRange,
} from '@/services/analytics.service';

/** build に渡す i18n 済みラベル群 (クライアントが useTranslations から組み立てる)。 */
export type AnalysisLabels = {
  /** 予定線の凡例 (例: 予定)。 */
  planned: string;
  /** 実績線の凡例 (例: 実績)。 */
  actual: string;
  /** 本日マーカーのラベル (例: 本日)。 */
  today: string;
  /** 予実カーブの Y 軸ラベル (例: 着手割合 (%))。 */
  yAxis: string;
  /** 消化工数チャートで上位以外をまとめる凡例 (例: その他)。 */
  others: string;
  /** 担当者未割当の凡例 (例: 未割当)。 */
  unassigned: string;
  /** 件数の単位 (例: 件)。 */
  countUnit: string;
  /** 工数の単位 (例: 人時)。 */
  effortUnit: string;
  /** 消化工数チャートの Y 軸ラベル (例: 実績工数（人時）)。 */
  throughputYAxis: string;
  /** 予実差チャートの Y 軸ラベル (例: 工数（人時）)。 */
  varianceYAxis: string;
  /** 作業負担チャートの Y 軸ラベル (例: 残工数（人時）)。 */
  workloadYAxis: string;
  /** 状態ラベル: 未着手。 */
  statusNotStarted: string;
  /** 状態ラベル: 進行中。 */
  statusInProgress: string;
  /** 状態ラベル: 保留。 */
  statusOnHold: string;
  /** 時間単位 (例: h)。日次工数ヒートマップのセル単位。 */
  hourUnit: string;
};

/** パネル1 (予実カーブ) の要約ヘッダーに出す数値。 */
export type AnalysisSummary = {
  totalActCount: number;
  completedActCount: number;
  today: string;
  plannedPctToday: number;
  actualPctToday: number;
  gapPctToday: number;
};

/** パネル2 (消化工数) の工数効率サマリ。 */
export type AnalysisEffortSummary = {
  /** 完了 ACT 総数。 */
  completedActCount: number;
  /** うち実工数入力済 (効率の母数)。 */
  effortLoggedCount: number;
  /** 効率対象の予定工数合計 (人時)。 */
  totalPlannedEffort: number;
  /** 効率対象の実績工数合計 (人時)。 */
  totalActualEffort: number;
  /** 工数効率 = 予定 ÷ 実績 (>1 効率的)。実工数が無ければ null。 */
  efficiency: number | null;
};

/** パネル4 (作業負担) の要約サマリ (平均/最大/最小)。 */
export type AnalysisWorkloadSummary = {
  /** 平均 (人時)。 */
  average: number;
  /** 最大値 (人時) と担当者ラベル。 */
  maxValue: number;
  maxAssignee: string;
  /** 最小値 (人時) と担当者ラベル。 */
  minValue: number;
  minAssignee: string;
};

/** パネル 1 枚分の描画データ。chart か heatmap のいずれかを持つ。 */
export type AnalysisRenderData = {
  /** 折れ線/棒チャート (heatmap パネルでは undefined)。 */
  chart?: AnalysisChart;
  /** ヒートマップ表 (パネル5 の日次工数。chart の代わり)。 */
  heatmap?: AnalysisHeatmap;
  /** パネル1 の予実サマリ (任意)。 */
  summary?: AnalysisSummary;
  /** パネル2 の工数効率サマリ (任意)。 */
  effortSummary?: AnalysisEffortSummary;
  /** パネル4 の作業負担サマリ (任意)。 */
  workloadSummary?: AnalysisWorkloadSummary;
};

/** パネルのモード切替 (例: 量 / 個人ペース補正)。 */
export type AnalysisPanelMode = {
  /** 安定キー (build に渡る)。 */
  key: string;
  /** 切替ボタンのラベル i18n キー (project namespace)。 */
  labelKey: string;
};

/**
 * 期間 (ツールバーの対象期間) の適用方向。パネルの性質ごとに意味が異なる:
 *   - 'past': 過去向き ([from,to] で対象を絞る)。予実カーブ / 週次消化工数 / 予実差。
 *   - 'future': 未来向き (to で未来の終端を絞る。from は無視)。日次工数。
 *   - 'none': 現在のスナップショットで期間の影響を受けない。作業負担。
 * クライアントはこの値で「過去側 range / 未来側 range / range なし」を出し分ける。
 */
export type AnalysisRangeKind = 'past' | 'future' | 'none';

/** 分析パネル定義。 */
export type AnalysisPanelDef<TRaw = unknown> = {
  /** 安定 ID。 */
  id: string;
  /** タイトルの i18n キー (project namespace)。 */
  titleKey: string;
  /** 説明の i18n キー (任意)。 */
  descriptionKey?: string;
  /** 期間の適用方向。 */
  rangeKind: AnalysisRangeKind;
  /** モード切替 (任意。指定時はカードにセグメント切替を表示。先頭が既定)。 */
  modes?: AnalysisPanelMode[];
  /** API から raw データを取得。range はツールバーで選んだ対象期間 (未指定なら全期間)。 */
  load: (projectId: string, range?: AnalyticsRange) => Promise<TRaw>;
  /** raw + ラベル (+ 選択モード) → 描画データ。mode はモード無しパネルでは undefined。 */
  build: (raw: TRaw, labels: AnalysisLabels, mode?: string) => AnalysisRenderData;
};

/** range を `?from=&to=` クエリ文字列にする (未指定の側は付けない)。 */
function rangeQuery(range?: AnalyticsRange): string {
  if (!range) return '';
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// 色 (Tailwind palette に対応)。予定=実線 / 実績=点線 (ユーザ確定仕様)。
const PLANNED_COLOR = '#6366f1'; // indigo-500
const ACTUAL_COLOR = '#16a34a'; // green-600
const TODAY_COLOR = '#f59e0b'; // amber-500

const PERCENT_TICKS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

async function loadWbsCurve(
  projectId: string,
  range?: AnalyticsRange,
): Promise<WbsCompletionResult> {
  const res = await fetch(`/api/projects/${projectId}/analytics/wbs-progress${rangeQuery(range)}`);
  if (!res.ok) throw new Error(`analytics fetch failed: ${res.status}`);
  const json = (await res.json()) as { data: WbsCompletionResult };
  return json.data;
}

function buildWbsChart(r: WbsCompletionResult, labels: AnalysisLabels): AnalysisRenderData {
  const chart: AnalysisChart = {
    yLabel: labels.yAxis,
    yUnit: '%',
    yMin: 0,
    yMax: 100,
    yTicks: PERCENT_TICKS,
    series: [
      {
        id: 'planned',
        label: labels.planned,
        color: PLANNED_COLOR,
        style: 'solid',
        data: r.points.map((p) => ({ x: p.date, y: p.plannedPct })),
      },
      {
        id: 'actual',
        label: labels.actual,
        color: ACTUAL_COLOR,
        style: 'dashed',
        data: r.points.map((p) => ({ x: p.date, y: p.actualPct })),
      },
    ],
    referenceLines:
      r.points.length > 0 ? [{ x: r.today, label: labels.today, color: TODAY_COLOR }] : [],
  };
  return {
    chart,
    summary: {
      totalActCount: r.totalActCount,
      completedActCount: r.completedActCount,
      today: r.today,
      plannedPctToday: r.plannedPctToday,
      actualPctToday: r.actualPctToday,
      gapPctToday: r.gapPctToday,
    },
  };
}

/** WBS 予実カーブ パネル (第一弾)。 */
export const WBS_COMPLETION_PANEL: AnalysisPanelDef<WbsCompletionResult> = {
  id: 'wbs-completion',
  titleKey: 'analysisWbsTitle',
  descriptionKey: 'analysisWbsDescription',
  rangeKind: 'past',
  load: loadWbsCurve,
  build: buildWbsChart,
};

// ---- パネル2: 担当者別 週次 消化工数 (積み上げ棒) + 工数効率 ----

/** 担当者セグメントの色 (上位 N 人に個別割当)。 */
const ASSIGNEE_COLORS = [
  '#6366f1', // indigo
  '#16a34a', // green
  '#f59e0b', // amber
  '#ec4899', // pink
  '#0ea5e9', // sky
  '#8b5cf6', // violet
  '#ef4444', // red
  '#14b8a6', // teal
];
const OTHERS_COLOR = '#9ca3af'; // gray-400 (その他)
const UNASSIGNED_COLOR = '#cbd5e1'; // slate-300 (未割当)
const TOP_ASSIGNEES = 8;

async function loadAssigneeEffort(
  projectId: string,
  range?: AnalyticsRange,
): Promise<AssigneeWeeklyEffortResult> {
  const res = await fetch(
    `/api/projects/${projectId}/analytics/assignee-throughput${rangeQuery(range)}`,
  );
  if (!res.ok) throw new Error(`analytics fetch failed: ${res.status}`);
  const json = (await res.json()) as { data: AssigneeWeeklyEffortResult };
  return json.data;
}

function buildAssigneeEffortChart(
  r: AssigneeWeeklyEffortResult,
  labels: AnalysisLabels,
): AnalysisRenderData {
  // 上位 N 人は個別系列、残りは「その他」に週次で合算。値は実績工数 (人時)。
  const top = r.assignees.slice(0, TOP_ASSIGNEES);
  const rest = r.assignees.slice(TOP_ASSIGNEES);

  const series = top.map((a, idx) => ({
    id: a.assigneeId ?? '__unassigned__',
    label: a.assigneeName ?? labels.unassigned,
    color: a.assigneeId === null ? UNASSIGNED_COLOR : ASSIGNEE_COLORS[idx % ASSIGNEE_COLORS.length],
    style: 'solid' as const, // 棒では未使用
    data: r.weekStarts.map((ws, i) => ({ x: ws, y: a.weekly[i] ?? 0 })),
  }));

  if (rest.length > 0) {
    const othersWeekly = r.weekStarts.map((_, i) =>
      rest.reduce((sum, a) => sum + (a.weekly[i] ?? 0), 0),
    );
    series.push({
      id: '__others__',
      label: labels.others,
      color: OTHERS_COLOR,
      style: 'solid' as const,
      data: r.weekStarts.map((ws, i) => ({ x: ws, y: othersWeekly[i] })),
    });
  }

  const chart: AnalysisChart = {
    kind: 'stacked-bar',
    yLabel: labels.throughputYAxis,
    yUnit: labels.effortUnit,
    series,
  };
  return {
    chart,
    effortSummary: {
      completedActCount: r.completedActCount,
      effortLoggedCount: r.effortLoggedCount,
      totalPlannedEffort: r.totalPlannedEffort,
      totalActualEffort: r.totalActualEffort,
      efficiency: r.efficiency,
    },
  };
}

/** 担当者別 週次 消化工数 + 工数効率 パネル (第二弾)。 */
export const ASSIGNEE_THROUGHPUT_PANEL: AnalysisPanelDef<AssigneeWeeklyEffortResult> = {
  id: 'assignee-throughput',
  titleKey: 'analysisThroughputTitle',
  descriptionKey: 'analysisThroughputDescription',
  rangeKind: 'past',
  load: loadAssigneeEffort,
  build: buildAssigneeEffortChart,
};

// ---- パネル3: 担当者別 予定 vs 実績 工数 (工数の予実差・グループ棒) ----

const PLANNED_EFFORT_COLOR = '#6366f1'; // indigo (予定)
const ACTUAL_EFFORT_COLOR = '#16a34a'; // green (実績)

async function loadAssigneeVariance(
  projectId: string,
  range?: AnalyticsRange,
): Promise<AssigneeEffortVarianceResult> {
  const res = await fetch(
    `/api/projects/${projectId}/analytics/assignee-effort-variance${rangeQuery(range)}`,
  );
  if (!res.ok) throw new Error(`analytics fetch failed: ${res.status}`);
  const json = (await res.json()) as { data: AssigneeEffortVarianceResult };
  return json.data;
}

function buildAssigneeVarianceChart(
  r: AssigneeEffortVarianceResult,
  labels: AnalysisLabels,
): AnalysisRenderData {
  // 上位 N 人は個別、残りは「その他」に予定/実績を合算。X = 担当者名。
  const top = r.assignees.slice(0, TOP_ASSIGNEES);
  const rest = r.assignees.slice(TOP_ASSIGNEES);

  // X カテゴリ (担当者ラベル) の並び。
  const categories = top.map((a) => a.assigneeName ?? labels.unassigned);
  const plannedByCat = top.map((a) => a.plannedEffort);
  const actualByCat = top.map((a) => a.actualEffort);

  if (rest.length > 0) {
    categories.push(labels.others);
    plannedByCat.push(round2(rest.reduce((s, a) => s + a.plannedEffort, 0)));
    actualByCat.push(round2(rest.reduce((s, a) => s + a.actualEffort, 0)));
  }

  const chart: AnalysisChart = {
    kind: 'grouped-bar',
    yLabel: labels.varianceYAxis,
    yUnit: labels.effortUnit,
    series: [
      {
        id: 'planned',
        label: labels.planned,
        color: PLANNED_EFFORT_COLOR,
        style: 'solid',
        data: categories.map((c, i) => ({ x: c, y: plannedByCat[i] })),
      },
      {
        id: 'actual',
        label: labels.actual,
        color: ACTUAL_EFFORT_COLOR,
        style: 'solid',
        data: categories.map((c, i) => ({ x: c, y: actualByCat[i] })),
      },
    ],
  };
  return { chart };
}

/** 小数 2 桁丸め。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 担当者別 予定 vs 実績 工数 パネル (第三弾)。 */
export const ASSIGNEE_EFFORT_VARIANCE_PANEL: AnalysisPanelDef<AssigneeEffortVarianceResult> = {
  id: 'assignee-effort-variance',
  titleKey: 'analysisVarianceTitle',
  descriptionKey: 'analysisVarianceDescription',
  rangeKind: 'past',
  load: loadAssigneeVariance,
  build: buildAssigneeVarianceChart,
};

// ---- パネル4: 担当者別 作業負担 (未完了の予定工数・状態別積み上げ) + モード切替 ----

const STATUS_NOT_STARTED_COLOR = '#94a3b8'; // slate-400 (未着手)
const STATUS_IN_PROGRESS_COLOR = '#3b82f6'; // blue-500 (進行中)
// 保留 (on_hold) は作業負担の集計対象外 (ユーザ要件)。色は不要。

async function loadAssigneeWorkload(projectId: string): Promise<AssigneeWorkloadResult> {
  // 作業負担は現在のスナップショットのため range を受け取らない (rangeKind='none')。
  const res = await fetch(`/api/projects/${projectId}/analytics/assignee-workload`);
  if (!res.ok) throw new Error(`analytics fetch failed: ${res.status}`);
  const json = (await res.json()) as { data: AssigneeWorkloadResult };
  return json.data;
}

function buildAssigneeWorkloadChart(
  r: AssigneeWorkloadResult,
  labels: AnalysisLabels,
  mode?: string,
): AnalysisRenderData {
  // 補正モード: 個人ペース比 (実績/予定) を掛けて「予想残工数」にする。履歴なしは ×1。
  const adjusted = mode === 'adjusted';
  const items = r.assignees
    .map((a) => {
      const f = adjusted ? a.paceRatio ?? 1 : 1;
      const notStarted = round2(a.notStarted * f);
      const inProgress = round2(a.inProgress * f);
      return {
        name: a.assigneeName ?? labels.unassigned,
        notStarted,
        inProgress,
        total: round2(notStarted + inProgress),
      };
    })
    // 表示値 (モード適用後) の重い順に並べ替え
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  // サマリ (平均/最大/最小) は個人 (その他に丸める前) で算出。
  let workloadSummary: AnalysisWorkloadSummary | undefined;
  if (items.length > 0) {
    const totals = items.map((i) => i.total);
    const average = round2(totals.reduce((s, n) => s + n, 0) / totals.length);
    const maxItem = items[0]; // sort 済 (降順)
    const minItem = items[items.length - 1];
    workloadSummary = {
      average,
      maxValue: maxItem.total,
      maxAssignee: maxItem.name,
      minValue: minItem.total,
      minAssignee: minItem.name,
    };
  }

  // 上位 N 人 + その他 (状態別に合算)
  const top = items.slice(0, TOP_ASSIGNEES);
  const rest = items.slice(TOP_ASSIGNEES);
  const categories = top.map((i) => i.name);
  const ns = top.map((i) => i.notStarted);
  const ip = top.map((i) => i.inProgress);
  if (rest.length > 0) {
    categories.push(labels.others);
    ns.push(round2(rest.reduce((s, i) => s + i.notStarted, 0)));
    ip.push(round2(rest.reduce((s, i) => s + i.inProgress, 0)));
  }

  const chart: AnalysisChart = {
    kind: 'stacked-bar',
    yLabel: labels.workloadYAxis,
    yUnit: labels.effortUnit,
    series: [
      {
        id: 'not_started',
        label: labels.statusNotStarted,
        color: STATUS_NOT_STARTED_COLOR,
        style: 'solid',
        data: categories.map((c, i) => ({ x: c, y: ns[i] })),
      },
      {
        id: 'in_progress',
        label: labels.statusInProgress,
        color: STATUS_IN_PROGRESS_COLOR,
        style: 'solid',
        data: categories.map((c, i) => ({ x: c, y: ip[i] })),
      },
    ],
  };
  return { chart, workloadSummary };
}

/** 担当者別 作業負担 パネル (第四弾)。量 / 個人ペース補正 を切替。 */
export const ASSIGNEE_WORKLOAD_PANEL: AnalysisPanelDef<AssigneeWorkloadResult> = {
  id: 'assignee-workload',
  titleKey: 'analysisWorkloadTitle',
  descriptionKey: 'analysisWorkloadDescription',
  rangeKind: 'none',
  modes: [
    { key: 'raw', labelKey: 'analysisWorkloadModeRaw' },
    { key: 'adjusted', labelKey: 'analysisWorkloadModeAdjusted' },
  ],
  load: loadAssigneeWorkload,
  build: buildAssigneeWorkloadChart,
};

// ---- パネル5: 担当者別 日次工数 (1 日 8h 上限チェック・ヒートマップ) ----

async function loadAssigneeDailyCapacity(
  projectId: string,
  range?: AnalyticsRange,
): Promise<AssigneeDailyCapacityResult> {
  const res = await fetch(
    `/api/projects/${projectId}/analytics/assignee-daily-capacity${rangeQuery(range)}`,
  );
  if (!res.ok) throw new Error(`analytics fetch failed: ${res.status}`);
  const json = (await res.json()) as { data: AssigneeDailyCapacityResult };
  return json.data;
}

/** YYYY-MM-DD を列見出し用に MM/DD へ短縮 (横軸が日次で増えるため省スペース)。 */
function toColumnLabel(ymd: string): string {
  // 'YYYY-MM-DD' → 'MM/DD'。形式が違えばそのまま返す。
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${m[1]}/${m[2]}` : ymd;
}

function buildAssigneeDailyCapacity(
  r: AssigneeDailyCapacityResult,
  labels: AnalysisLabels,
): AnalysisRenderData {
  const heatmap: AnalysisHeatmap = {
    columns: r.dates.map(toColumnLabel),
    unit: labels.hourUnit,
    rows: r.assignees.map((a) => ({
      label: a.assigneeName ?? labels.unassigned,
      cells: a.cells.map((c) => (c == null ? null : { value: c.effortHours, level: c.level })),
    })),
  };
  return { heatmap };
}

/** 担当者別 日次工数 (8h 上限チェック) パネル (第五弾・ヒートマップ)。 */
export const ASSIGNEE_DAILY_CAPACITY_PANEL: AnalysisPanelDef<AssigneeDailyCapacityResult> = {
  id: 'assignee-daily-capacity',
  titleKey: 'analysisCapacityTitle',
  descriptionKey: 'analysisCapacityDescription',
  rangeKind: 'future',
  load: loadAssigneeDailyCapacity,
  build: buildAssigneeDailyCapacity,
};

/** 分析タブに表示するパネル群 (上から順に描画)。 */
export const ANALYSIS_PANELS: AnalysisPanelDef[] = [
  WBS_COMPLETION_PANEL as AnalysisPanelDef,
  ASSIGNEE_THROUGHPUT_PANEL as AnalysisPanelDef,
  ASSIGNEE_EFFORT_VARIANCE_PANEL as AnalysisPanelDef,
  ASSIGNEE_WORKLOAD_PANEL as AnalysisPanelDef,
  ASSIGNEE_DAILY_CAPACITY_PANEL as AnalysisPanelDef,
];
