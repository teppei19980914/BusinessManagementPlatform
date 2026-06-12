'use client';

/**
 * 汎用 グループ棒チャート (分析タブ基盤)
 *
 * 役割:
 *   `AnalysisChart` 契約 (kind='grouped-bar') を受け取り、同一 X に複数系列を
 *   **横並び (積み上げない)** で描く。各系列 = 1 比較軸 (例: 予定 / 実績)、
 *   X = カテゴリ (例: 担当者)。ドメインを知らないため再利用できる。
 *
 * 特徴:
 *   - ちょうど 2 系列 (予定/実績) を想定。ツールチップに各値 + 差分を表示。
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

/** Recharts 3 の content 型は不安定なため最小 shape のみ定義。 */
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

type GroupedBarChartProps = {
  chart: AnalysisChart;
  height?: number;
  emptyLabel?: string;
  /** 差分ラベル (例: 差)。指定時、2 系列の差 (2 番目 − 1 番目) を表示。 */
  diffLabel?: string;
};

type Row = { x: string } & Record<string, string | number | null>;

export function GroupedBarChart({ chart, height = 360, emptyLabel, diffLabel }: GroupedBarChartProps) {
  const { series } = chart;
  const unit = chart.yUnit ?? '';

  const rows = useMemo<Row[]>(() => {
    const xs: string[] = [];
    const seen = new Set<string>();
    const perSeries = new Map<string, Map<string, number | null>>();
    for (const s of series) {
      const m = new Map<string, number | null>();
      for (const p of s.data) {
        if (!seen.has(p.x)) {
          seen.add(p.x);
          xs.push(p.x); // 元の系列順 (= 担当者の並び) を保持
        }
        m.set(p.x, p.y);
      }
      perSeries.set(s.id, m);
    }
    return xs.map((x) => {
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

  const labelById = new Map(series.map((s) => [s.id, s.label]));

  const renderTooltip = (props: BarTooltipProps): ReactNode => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    const entries = props.payload;
    // 差分 = 2 番目の系列 − 1 番目の系列 (例: 実績 − 予定)。
    let diffNode: ReactNode = null;
    if (diffLabel && entries.length >= 2) {
      const first = typeof entries[0].value === 'number' ? entries[0].value : 0;
      const second = typeof entries[1].value === 'number' ? entries[1].value : 0;
      const diff = Math.round((second - first) * 100) / 100;
      const sign = diff > 0 ? '+' : '';
      const cls = diff > 0 ? 'text-destructive' : diff < 0 ? 'text-green-600' : 'text-gray-600';
      diffNode = (
        <div className="mt-1 flex items-center gap-1.5 border-t border-gray-100 pt-1">
          <span className="text-gray-500">{diffLabel}</span>
          <span className={`ml-auto font-semibold ${cls}`}>
            {sign}
            {diff}
            {unit}
          </span>
        </div>
      );
    }
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
        {diffNode}
      </div>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 16, right: 24, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
        <XAxis dataKey="x" tick={{ fontSize: 11 }} interval={0} tickMargin={8} />
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
          <Bar key={s.id} dataKey={s.id} name={s.label} fill={s.color} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
