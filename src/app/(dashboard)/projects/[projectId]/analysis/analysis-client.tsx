'use client';

/**
 * 分析タブ クライアント (器)
 *
 * 役割:
 *   analysis-panels.ts に登録されたパネル群をカードで縦に並べ、各パネルを
 *   独立に fetch して TimeSeriesChart で描画する。第一弾は WBS 予実カーブ 1 枚。
 *
 * 認可:
 *   タブ自体の表示は project-detail-client 側で admin / pm_tl に制限済。
 *   API も checkProjectPermission('analytics:read') で二重に守られる。
 *
 * データ取得:
 *   SuggestionsPanel と同様、本コンポーネントが自前で fetch する
 *   (親の LazyTabContent には乗せない)。
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { TimeSeriesChart } from '@/components/charts/time-series-chart';
import { StackedBarChart } from '@/components/charts/stacked-bar-chart';
import { GroupedBarChart } from '@/components/charts/grouped-bar-chart';
import { HeatmapTable } from '@/components/charts/heatmap-table';
import { useSessionState } from '@/lib/use-session-state';
import type { AnalyticsRange } from '@/services/analytics.service';
import {
  ANALYSIS_PANELS,
  type AnalysisPanelDef,
  type AnalysisRenderData,
} from './analysis-panels';
import {
  resolveRanges,
  rangeForKind,
  isPeriodActive,
  clientTodayYmd,
  type AnalysisPeriod,
  type PeriodPreset,
} from './analysis-period';

type AnalyticsClientProps = {
  projectId: string;
  /** 表示設定 (表示グラフ・期間) を保存する sessionStorage キーのユーザスコープに使う。 */
  viewerUserId: string;
};

/** 初期表示するパネル (見づらさ解消のため初回は予実カーブ 1 枚のみ)。 */
const DEFAULT_VISIBLE = ['wbs-completion'];

const PERIOD_PRESETS: { key: PeriodPreset; labelKey: string }[] = [
  { key: 'all', labelKey: 'analysisPeriodAll' },
  { key: '1m', labelKey: 'analysisPeriod1m' },
  { key: '3m', labelKey: 'analysisPeriod3m' },
  { key: '6m', labelKey: 'analysisPeriod6m' },
  { key: 'custom', labelKey: 'analysisPeriodCustom' },
];

export function AnalyticsClient({ projectId, viewerUserId }: AnalyticsClientProps) {
  const t = useTranslations('project');
  // 表示グラフ・期間はユーザ単位でキーを分離 (越境防御 / chat-history-storage と同方針)。
  const [visiblePanels, setVisiblePanels] = useSessionState<string[]>(
    `analysis-visible:${viewerUserId}`,
    () => DEFAULT_VISIBLE,
  );
  const [period, setPeriod] = useSessionState<AnalysisPeriod>(
    `analysis-period:${viewerUserId}`,
    () => ({ preset: 'all' }),
  );

  const ranges = useMemo(() => resolveRanges(period, clientTodayYmd()), [period]);
  const periodActive = isPeriodActive(period);

  const togglePanel = (id: string) => {
    setVisiblePanels((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  };

  const shown = ANALYSIS_PANELS.filter((p) => visiblePanels.includes(p.id));

  return (
    <div className="space-y-4">
      {/* ツールバー: 表示グラフの選択 + 対象期間 */}
      <div className="sticky top-0 z-10 space-y-3 rounded-lg border border-gray-200 bg-white/95 p-3 shadow-sm backdrop-blur">
        {/* 表示グラフ チップ (複数選択) */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-gray-500">{t('analysisShowGraphs')}</span>
          {ANALYSIS_PANELS.map((p) => {
            const on = visiblePanels.includes(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => togglePanel(p.id)}
                aria-pressed={on}
                className={
                  on
                    ? 'rounded-full border border-gray-800 bg-gray-800 px-3 py-1 text-xs font-medium text-white'
                    : 'rounded-full border border-gray-300 bg-white px-3 py-1 text-xs text-gray-600 hover:bg-gray-50'
                }
              >
                {t(p.titleKey)}
              </button>
            );
          })}
        </div>
        {/* 対象期間 プリセット + カスタム */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-gray-500">{t('analysisPeriodLabel')}</span>
          <div className="inline-flex overflow-hidden rounded-md border border-gray-300 text-xs">
            {PERIOD_PRESETS.map((pr) => (
              <button
                key={pr.key}
                type="button"
                onClick={() => setPeriod((prev) => ({ ...prev, preset: pr.key }))}
                aria-pressed={period.preset === pr.key}
                className={
                  period.preset === pr.key
                    ? 'bg-gray-800 px-3 py-1 font-medium text-white'
                    : 'bg-white px-3 py-1 text-gray-600 hover:bg-gray-50'
                }
              >
                {t(pr.labelKey)}
              </button>
            ))}
          </div>
          {period.preset === 'custom' && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-600">
              <input
                type="date"
                aria-label={t('analysisPeriodFrom')}
                value={period.customFrom ?? ''}
                onChange={(e) =>
                  setPeriod((prev) => ({ ...prev, customFrom: e.target.value || null }))
                }
                className="rounded border border-gray-300 px-2 py-1"
              />
              <span>–</span>
              <input
                type="date"
                aria-label={t('analysisPeriodTo')}
                value={period.customTo ?? ''}
                onChange={(e) =>
                  setPeriod((prev) => ({ ...prev, customTo: e.target.value || null }))
                }
                className="rounded border border-gray-300 px-2 py-1"
              />
            </div>
          )}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="flex h-[160px] items-center justify-center rounded-lg border border-dashed border-gray-300 text-sm text-gray-500">
          {t('analysisNoGraphSelected')}
        </div>
      ) : (
        <div className="space-y-6">
          {shown.map((panel) => (
            <AnalysisPanelCard
              key={panel.id}
              projectId={projectId}
              panel={panel}
              range={rangeForKind(panel.rangeKind, ranges)}
              periodActive={periodActive}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type FetchState = 'loading' | 'error' | 'ready';

function AnalysisPanelCard({
  projectId,
  panel,
  range,
  periodActive,
}: {
  projectId: string;
  panel: AnalysisPanelDef;
  range?: AnalyticsRange;
  periodActive: boolean;
}) {
  const t = useTranslations('project');
  const [state, setState] = useState<FetchState>('loading');
  const [raw, setRaw] = useState<unknown>(null);
  // モード切替 (パネルが modes を持つ場合のみ。先頭が既定)。
  const [selectedMode, setSelectedMode] = useState<string>(panel.modes?.[0]?.key ?? '');

  // range はオブジェクトのため安定キーで依存に含める (期間変更で再取得)。
  const rangeKey = JSON.stringify(range ?? null);

  useEffect(() => {
    // 初期マウント / 期間変更で取得。再取得中は直前の表示を残し、完了時に差し替える
    // (loading フラッシュを避ける。初回は state='loading'/raw=null のため読込表示になる)。
    let active = true;
    panel
      .load(projectId, range)
      .then((r) => {
        if (!active) return;
        setRaw(r);
        setState('ready');
      })
      .catch(() => {
        if (active) setState('error');
      });
    return () => {
      active = false;
    };
    // rangeKey は range の安定表現。range 自体は毎レンダー新規生成のため依存に使わない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, panel, rangeKey]);

  // ラベルは i18n から。文字列は安定なので useMemo の依存に直接含める。
  const planned = t('analysisPlanned');
  const actual = t('analysisActual');
  const todayLabel = t('analysisToday');
  const yAxis = t('analysisYAxis');
  const others = t('analysisOthers');
  const unassigned = t('analysisUnassigned');
  const countUnit = t('analysisCountUnit');
  const effortUnit = t('analysisEffortUnit');
  const throughputYAxis = t('analysisThroughputYAxis');
  const varianceYAxis = t('analysisVarianceYAxis');
  const workloadYAxis = t('analysisWorkloadYAxis');
  const statusNotStarted = t('analysisStatusNotStarted');
  const statusInProgress = t('analysisStatusInProgress');
  const statusOnHold = t('analysisStatusOnHold');
  const hourUnit = t('analysisHourUnit');

  const render = useMemo<AnalysisRenderData | null>(() => {
    if (state !== 'ready' || raw == null) return null;
    return panel.build(
      raw,
      {
        planned,
        actual,
        today: todayLabel,
        yAxis,
        others,
        unassigned,
        countUnit,
        effortUnit,
        throughputYAxis,
        varianceYAxis,
        workloadYAxis,
        statusNotStarted,
        statusInProgress,
        statusOnHold,
        hourUnit,
      },
      panel.modes ? selectedMode : undefined,
    );
  }, [state, raw, panel, selectedMode, planned, actual, todayLabel, yAxis, others, unassigned, countUnit, effortUnit, throughputYAxis, varianceYAxis, workloadYAxis, statusNotStarted, statusInProgress, statusOnHold, hourUnit]);

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <header className="mb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold text-gray-900">{t(panel.titleKey)}</h3>
          {panel.modes && panel.modes.length > 1 && (
            <div className="inline-flex overflow-hidden rounded-md border border-gray-300 text-xs">
              {panel.modes.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setSelectedMode(m.key)}
                  className={
                    m.key === selectedMode
                      ? 'bg-gray-800 px-3 py-1 font-medium text-white'
                      : 'bg-white px-3 py-1 text-gray-600 hover:bg-gray-50'
                  }
                  aria-pressed={m.key === selectedMode}
                >
                  {t(m.labelKey)}
                </button>
              ))}
            </div>
          )}
        </div>
        {panel.descriptionKey && (
          <p className="mt-1 text-sm text-gray-500">{t(panel.descriptionKey)}</p>
        )}
        {/* 期間が指定されているとき、性質上そのまま効かないパネルに注記を出す。 */}
        {periodActive && panel.rangeKind === 'none' && (
          <p className="mt-1 text-xs text-amber-700">{t('analysisPeriodNoteSnapshot')}</p>
        )}
        {periodActive && panel.rangeKind === 'future' && (
          <p className="mt-1 text-xs text-amber-700">{t('analysisPeriodNoteFuture')}</p>
        )}
      </header>

      {state === 'loading' && (
        <div className="flex h-[360px] items-center justify-center text-sm text-gray-500">
          {t('analysisLoading')}
        </div>
      )}

      {state === 'error' && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {t('analysisError')}
        </div>
      )}

      {state === 'ready' && render && (
        <>
          {render.summary && <SummaryHeader summary={render.summary} />}
          {render.effortSummary && <EffortSummaryHeader summary={render.effortSummary} />}
          {render.workloadSummary && <WorkloadSummaryHeader summary={render.workloadSummary} />}
          {render.heatmap ? (
            <HeatmapTable
              heatmap={render.heatmap}
              emptyLabel={t('analysisEmpty')}
              legendLabels={{
                ok: t('analysisCapacityLegendOk'),
                warning: t('analysisCapacityLegendWarning'),
                alert: t('analysisCapacityLegendAlert'),
              }}
            />
          ) : render.chart ? (
            render.chart.kind === 'stacked-bar' ? (
              <StackedBarChart chart={render.chart} emptyLabel={t('analysisEmpty')} />
            ) : render.chart.kind === 'grouped-bar' ? (
              <GroupedBarChart
                chart={render.chart}
                emptyLabel={t('analysisEmpty')}
                diffLabel={t('analysisVarianceDiff')}
              />
            ) : (
              <TimeSeriesChart chart={render.chart} emptyLabel={t('analysisEmpty')} />
            )
          ) : null}
        </>
      )}
    </section>
  );
}

function SummaryHeader({ summary }: { summary: NonNullable<AnalysisRenderData['summary']> }) {
  const t = useTranslations('project');
  const { plannedPctToday, actualPctToday, gapPctToday, completedActCount, totalActCount } = summary;

  // 遅れ/先行/予定どおり の文言。
  let gapText: string;
  let gapClass: string;
  if (gapPctToday < 0) {
    gapText = `${Math.abs(gapPctToday)}% ${t('analysisBehind')}`;
    gapClass = 'text-destructive';
  } else if (gapPctToday > 0) {
    gapText = `${gapPctToday}% ${t('analysisAhead')}`;
    gapClass = 'text-green-600';
  } else {
    gapText = t('analysisOnTrack');
    gapClass = 'text-gray-600';
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
      <span className="font-medium text-gray-700">{t('analysisSummaryToday')}</span>
      <span>
        <span className="text-gray-500">{t('analysisPlanned')}</span>{' '}
        <span className="font-semibold text-gray-900">{plannedPctToday}%</span>
      </span>
      <span>
        <span className="text-gray-500">{t('analysisActual')}</span>{' '}
        <span className="font-semibold text-gray-900">{actualPctToday}%</span>
      </span>
      <span className={gapClass}>（{gapText}）</span>
      <span className="text-gray-500">
        {t('analysisCompleted')} {completedActCount}/{totalActCount}
        {t('analysisCountUnit')}
      </span>
    </div>
  );
}

function EffortSummaryHeader({
  summary,
}: {
  summary: NonNullable<AnalysisRenderData['effortSummary']>;
}) {
  const t = useTranslations('project');
  const unit = t('analysisEffortUnit');
  const { efficiency, totalPlannedEffort, totalActualEffort, completedActCount, effortLoggedCount } =
    summary;

  // 工数効率の評価文言 (>1 効率的 / <1 想定超過 / =1 見積どおり)。
  let effText: string;
  let effClass: string;
  if (efficiency === null) {
    effText = t('analysisEfficiencyNoData');
    effClass = 'text-gray-500';
  } else if (efficiency > 1) {
    effText = `${efficiency}（${t('analysisEfficient')}）`;
    effClass = 'text-green-600';
  } else if (efficiency < 1) {
    effText = `${efficiency}（${t('analysisOverBudget')}）`;
    effClass = 'text-destructive';
  } else {
    effText = `${efficiency}（${t('analysisAsEstimated')}）`;
    effClass = 'text-gray-600';
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
      <span className="font-medium text-gray-700">{t('analysisEfficiencyLabel')}</span>
      <span className={`font-semibold ${effClass}`}>{effText}</span>
      {efficiency !== null && (
        <span className="text-gray-500">
          {t('analysisPlanned')} {totalPlannedEffort} / {t('analysisActual')} {totalActualEffort}
          {unit}
        </span>
      )}
      <span className="text-gray-500">
        {t('analysisCompleted')} {completedActCount}
        {t('analysisCountUnit')}
        {'（'}
        {t('analysisEffortLoggedNote')} {effortLoggedCount}
        {t('analysisCountUnit')}
        {'）'}
      </span>
    </div>
  );
}

function WorkloadSummaryHeader({
  summary,
}: {
  summary: NonNullable<AnalysisRenderData['workloadSummary']>;
}) {
  const t = useTranslations('project');
  const unit = t('analysisEffortUnit');
  const { average, maxValue, maxAssignee, minValue, minAssignee } = summary;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
      <span>
        <span className="text-gray-500">{t('analysisWorkloadAverage')}</span>{' '}
        <span className="font-semibold text-gray-900">
          {average}
          {unit}
        </span>
      </span>
      <span className="text-destructive">
        {t('analysisWorkloadMax')} {maxAssignee} {maxValue}
        {unit}
      </span>
      <span className="text-green-600">
        {t('analysisWorkloadMin')} {minAssignee} {minValue}
        {unit}
      </span>
    </div>
  );
}
