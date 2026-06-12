'use client';

/**
 * 汎用 時系列折れ線チャート (分析タブ基盤)
 *
 * 役割:
 *   `AnalysisChart` 契約 (charts/types.ts) のみを受け取り、Recharts で折れ線を描く。
 *   ドメイン (WBS / 課題 / リスク 等) を一切知らないため、どの分析パネルからでも再利用できる。
 *
 * 特徴:
 *   - 複数系列を 1 つの X 軸 (日次) に重ねて描画。系列ごとに実線/点線・色を指定。
 *   - y が null の点で線を途切れさせる (例: 実績線は本日以降を描かない)。
 *   - 縦の参照線 (本日マーカー等) に対応。
 *   - データが無ければ空状態メッセージを表示。
 *
 * 依存: recharts (React 19 対応 v3)。本部品は遅延ロードされるタブ内でのみ import されるため
 *   初期バンドルには含まれない。
 */

import { useMemo } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from 'recharts';
import type { AnalysisChart } from './types';

type TimeSeriesChartProps = {
  chart: AnalysisChart;
  /** 描画高さ (px)。既定 360。 */
  height?: number;
  /** データが無いときに表示する文言。 */
  emptyLabel?: string;
};

/** X 値 → 各系列 ID の値 にまとめた Recharts 用の 1 行。 */
type Row = { x: string } & Record<string, string | number | null>;

export function TimeSeriesChart({ chart, height = 360, emptyLabel }: TimeSeriesChartProps) {
  const { series, referenceLines } = chart;

  // 系列群を 1 本の X 軸に対する行配列へマージする。
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

  const hasData = rows.length > 0 && series.some((s) => s.data.some((p) => p.y !== null));

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

  const unit = chart.yUnit ?? '';
  const yDomain: [number | string, number | string] = [
    chart.yMin ?? 'auto',
    chart.yMax ?? 'auto',
  ];

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={rows} margin={{ top: 16, right: 24, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis
          dataKey="x"
          tick={{ fontSize: 11 }}
          minTickGap={28}
          tickMargin={8}
        />
        <YAxis
          domain={yDomain}
          ticks={chart.yTicks}
          tick={{ fontSize: 11 }}
          tickFormatter={(v: number) => `${v}${unit}`}
          width={48}
          label={
            chart.yLabel
              ? { value: chart.yLabel, angle: -90, position: 'insideLeft', fontSize: 11 }
              : undefined
          }
        />
        <Tooltip
          formatter={(value) => (value === null || value === undefined ? '—' : `${value}${unit}`)}
        />
        <Legend />
        {(referenceLines ?? []).map((rl) => (
          <ReferenceLine
            key={`ref-${rl.x}`}
            x={rl.x}
            stroke={rl.color ?? '#6b7280'}
            strokeDasharray="4 2"
            label={rl.label ? { value: rl.label, position: 'top', fontSize: 11, fill: rl.color ?? '#6b7280' } : undefined}
          />
        ))}
        {series.map((s) => (
          <Line
            key={s.id}
            type="monotone"
            dataKey={s.id}
            name={s.label}
            stroke={s.color}
            strokeWidth={2}
            strokeDasharray={s.style === 'dashed' ? '6 4' : undefined}
            dot={false}
            activeDot={{ r: 4 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
