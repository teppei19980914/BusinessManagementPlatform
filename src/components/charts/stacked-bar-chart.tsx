'use client';

/**
 * 汎用 積み上げ棒チャート (分析タブ基盤)
 *
 * 役割:
 *   `AnalysisChart` 契約 (kind='stacked-bar') を受け取り、Recharts で積み上げ棒を描く。
 *   各系列 (AnalysisSeries) = 1 カテゴリ (例: 担当者) で、同一 X (例: 週) に積み上げる。
 *   ドメインを知らないため、どの分析パネルからでも再利用できる (TimeSeriesChart と対)。
 *
 * 特徴:
 *   - 系列ごとに色を割り当て、stackId で積み上げ。
 *   - ツールチップに各カテゴリの値 + 合計を表示。
 *   - データが無ければ空状態メッセージ。
 */

import { useMemo, type ReactNode } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import type { AnalysisChart } from './types';

/** Recharts 3 の content 型は不安定なため、本部品が使う最小 shape のみ定義する。 */
type BarTooltipEntry = {
  dataKey?: string | number;
  name?: string | number;
  value?: number | null;
  color?: string;
};
type BarTooltipProps = {
  active?: boolean;
  label?: string | number;
  payload?: BarTooltipEntry[];
};

type StackedBarChartProps = {
  chart: AnalysisChart;
  height?: number;
  emptyLabel?: string;
};

type Row = { x: string } & Record<string, string | number | null>;

const STACK_ID = 'stack';

export function StackedBarChart({ chart, height = 360, emptyLabel }: StackedBarChartProps) {
  const { series } = chart;
  const unit = chart.yUnit ?? '';

  const rows = useMemo<Row[]>(() => {
    const xs = new Set<string>();
    const perSeries = new Map<string, Map<string, number | null>>();
    for (const s of series) {
      const m = new Map<string, number | null>();
      for (const p of s.data) {
        xs.add(p.x);
        m.set(p.x, p.y);
      }
      perSeries.set(s.id, m);
    }
    const sortedXs = Array.from(xs).sort();
    return sortedXs.map((x) => {
      const row: Row = { x };
      for (const s of series) {
        const v = perSeries.get(s.id)?.get(x);
        row[s.id] = v === undefined ? null : v;
      }
      return row;
    });
  }, [series]);

  const hasData = rows.length > 0 && series.some((s) => s.data.some((p) => (p.y ?? 0) > 0));

  if (!hasData) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed border-gray-300 text-sm text-gray-500"
        style={{ height }}
      >
        {emptyLabel ?? 'データがありません'}
      </div>
    );
  }

  // 凡例で id → label を引けるようにする。
  const labelById = new Map(series.map((s) => [s.id, s.label]));

  const renderTooltip = (props: BarTooltipProps): ReactNode => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    const entries = props.payload.filter((e) => (e.value ?? 0) > 0);
    const total = entries.reduce(
      (sum, e) => sum + (typeof e.value === 'number' ? e.value : 0),
      0,
    );
    return (
      <div className="rounded-md border border-gray-200 bg-white p-2 text-xs shadow-sm">
        <div className="mb-1 font-medium text-gray-700">{String(props.label)}</div>
        {entries.map((e) => (
          <div key={String(e.dataKey)} className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-sm" style={{ backgroundColor: e.color }} />
            <span className="text-gray-600">{labelById.get(String(e.dataKey)) ?? String(e.name)}</span>
            <span className="ml-auto font-medium text-gray-900">
              {e.value}
              {unit}
            </span>
          </div>
        ))}
        <div className="mt-1 flex items-center gap-1.5 border-t border-gray-100 pt-1">
          <span className="text-gray-500">合計</span>
          <span className="ml-auto font-semibold text-gray-900">
            {total}
            {unit}
          </span>
        </div>
      </div>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 16, right: 24, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
        <XAxis dataKey="x" tick={{ fontSize: 11 }} minTickGap={16} tickMargin={8} />
        <YAxis
          allowDecimals={false}
          tick={{ fontSize: 11 }}
          tickFormatter={(v: number) => `${v}${unit}`}
          width={44}
          label={
            chart.yLabel
              ? { value: chart.yLabel, angle: -90, position: 'insideLeft', fontSize: 11 }
              : undefined
          }
        />
        <Tooltip content={renderTooltip as never} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
        <Legend />
        {series.map((s) => (
          <Bar
            key={s.id}
            dataKey={s.id}
            name={s.label}
            stackId={STACK_ID}
            fill={s.color}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
