'use client';

/**
 * 汎用 ヒートマップ表 (分析タブ基盤)
 *
 * 役割:
 *   `AnalysisHeatmap` 契約 (charts/types.ts) のみを受け取り、行 × 列のセルを
 *   閾値レベル (ok / warning / alert) の色で塗り分ける「一覧」を描く。
 *   ドメインを知らないため再利用できる (例: 担当者 × 日付 の日次工数 8h 上限チェック)。
 *
 * 特徴:
 *   - 1 列目 (行ラベル) は横スクロール時も固定 (sticky)。
 *   - セル色: ok=無色 / warning=黄 / alert=赤。値が無い列は空セル。
 *   - 凡例を下部に表示。データが無ければ空状態メッセージ。
 */

import type { AnalysisHeatmap } from './types';

type HeatmapTableProps = {
  heatmap: AnalysisHeatmap;
  emptyLabel?: string;
  /** 凡例ラベル (i18n 済み)。 */
  legendLabels: { ok: string; warning: string; alert: string };
};

const LEVEL_CELL_CLASS: Record<'ok' | 'warning' | 'alert', string> = {
  ok: 'bg-white text-gray-700',
  warning: 'bg-amber-100 text-amber-900',
  alert: 'bg-red-200 text-red-900 font-semibold',
};
const LEGEND_SWATCH_CLASS: Record<'ok' | 'warning' | 'alert', string> = {
  ok: 'bg-white border border-gray-300',
  warning: 'bg-amber-100',
  alert: 'bg-red-200',
};

export function HeatmapTable({ heatmap, emptyLabel, legendLabels }: HeatmapTableProps) {
  const { columns, rows, unit = '' } = heatmap;
  const hasData = rows.length > 0 && columns.length > 0;

  if (!hasData) {
    return (
      <div className="flex h-[160px] items-center justify-center rounded-md border border-dashed border-gray-300 text-sm text-gray-500">
        {emptyLabel ?? 'データがありません'}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border border-gray-200">
        <table className="border-collapse text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 border-b border-r border-gray-200 bg-gray-50 px-2 py-1.5 text-left font-medium text-gray-600">
                {/* 行ラベル列のヘッダ (担当者) は空 */}
              </th>
              {columns.map((c) => (
                <th
                  key={c}
                  className="whitespace-nowrap border-b border-gray-200 bg-gray-50 px-2 py-1.5 text-center font-normal text-gray-500"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 whitespace-nowrap border-r border-gray-200 bg-white px-2 py-1.5 text-left font-medium text-gray-800"
                >
                  {row.label}
                </th>
                {row.cells.map((cell, i) => (
                  <td
                    key={columns[i]}
                    className={`border-b border-gray-100 px-2 py-1.5 text-center tabular-nums ${
                      cell ? LEVEL_CELL_CLASS[cell.level] : 'bg-gray-50 text-gray-300'
                    }`}
                  >
                    {cell ? `${cell.value}${unit}` : '−'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
        {(['ok', 'warning', 'alert'] as const).map((lv) => (
          <span key={lv} className="inline-flex items-center gap-1.5">
            <span className={`inline-block size-3 rounded-sm ${LEGEND_SWATCH_CLASS[lv]}`} />
            {legendLabels[lv]}
          </span>
        ))}
      </div>
    </div>
  );
}
