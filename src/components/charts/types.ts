/**
 * 汎用チャート データ契約 (分析タブ基盤)
 *
 * 役割:
 *   `TimeSeriesChart` などの汎用チャート部品が受け取る、**データ源に依存しない**
 *   表示用の中立フォーマット。WBS 予実カーブはこの契約を満たす 1 例にすぎず、
 *   将来の分析 (課題バーンダウン / リスク推移 等) も同じ契約で描画できる。
 *
 * 設計方針 (ADR: 汎用分析タブ基盤):
 *   - サービス層は「ドメイン数値」(件数・割合) を返すだけで表示を知らない。
 *   - パネル (analysis-panels.ts) の `toChart()` が、ドメイン数値 + i18n から
 *     この `AnalysisChart` を組み立てる。
 *   - 本部品 (`TimeSeriesChart`) は `AnalysisChart` のみを知り、ドメインを知らない。
 *   この 3 層分離により、分析の追加は「fetch + toChart を 1 つ書く」だけで済む。
 */

/** 系列の線種。実線=予定 / 点線=実績 のように意味を style で出し分ける。 */
export type AnalysisSeriesStyle = 'solid' | 'dashed';

/** 1 本の折れ線 (系列)。 */
export type AnalysisSeries = {
  /** 系列の安定 ID (例: 'planned' | 'actual')。Recharts の dataKey に使う。 */
  id: string;
  /** 凡例に表示するラベル (i18n 済みの表示文字列)。 */
  label: string;
  /** 線・点の色 (HEX)。 */
  color: string;
  /** 線種。 */
  style: AnalysisSeriesStyle;
  /**
   * 各 X 座標の値。`y` が null の点は線を途切れさせる
   * (例: 実績線は本日以降を null にして未来を描かない)。
   */
  data: { x: string; y: number | null }[];
};

/** 縦の参照線 (例: 本日マーカー)。 */
export type AnalysisReferenceLine = {
  /** X 座標 (X 軸の値と同じ形式。日次なら 'YYYY-MM-DD')。 */
  x: string;
  /** 線の上に出す短いラベル。 */
  label?: string;
  /** 線の色 (HEX)。未指定なら部品側の既定色。 */
  color?: string;
};

/**
 * チャート 1 枚分の中立フォーマット。
 *
 * `kind` で描画形式を切り替える:
 *   - 'line' (既定): 系列ごとに折れ線。各系列の data は {x, y}。
 *   - 'stacked-bar': 系列を同一 X で積み上げる棒グラフ。各系列 = 1 カテゴリ
 *     (例: 担当者)。style は無視。色は系列ごとのセグメント色。
 *   - 'grouped-bar': 系列を同一 X で横並びにする棒グラフ (積み上げない)。
 *     各系列 = 1 比較軸 (例: 予定 / 実績)。X = カテゴリ (例: 担当者)。
 * いずれも `series` (AnalysisSeries) を共有するため、データ源は同じ契約で表現できる。
 */
export type AnalysisChart = {
  /** 描画形式 (既定 'line')。 */
  kind?: 'line' | 'stacked-bar' | 'grouped-bar';
  /** X 軸ラベル (任意)。 */
  xLabel?: string;
  /** Y 軸ラベル (任意)。 */
  yLabel?: string;
  /** Y 軸の単位サフィックス (例: '%')。目盛・ツールチップに付与。 */
  yUnit?: string;
  /** Y 軸の最小値 (任意。割合チャートは 0)。 */
  yMin?: number;
  /** Y 軸の最大値 (任意。割合チャートは 100)。 */
  yMax?: number;
  /** Y 軸の明示目盛 (任意。割合チャートは 0,10,...,100)。 */
  yTicks?: number[];
  /** 折れ線の系列群。 */
  series: AnalysisSeries[];
  /** 縦の参照線 (任意)。 */
  referenceLines?: AnalysisReferenceLine[];
};

/**
 * ヒートマップ表の 1 セル。閾値判定のレベルで色を出し分ける。
 * `level`: 'ok' / 'warning' (黄) / 'alert' (赤)。
 */
export type AnalysisHeatmapCell = {
  /** 値 (例: その日の予定工数 h)。 */
  value: number;
  /** 閾値レベル (色分け用)。 */
  level: 'ok' | 'warning' | 'alert';
};

/** ヒートマップ表の 1 行 (例: 1 担当者)。 */
export type AnalysisHeatmapRow = {
  /** 行ラベル (例: 担当者名)。 */
  label: string;
  /** columns と同じ index のセル。値が無い (割当なし) 列は null。 */
  cells: (AnalysisHeatmapCell | null)[];
};

/**
 * ヒートマップ表 1 枚分の中立フォーマット (折れ線/棒とは別形式)。
 * 行 × 列のセルを色 (level) で塗り分ける「一覧」表現。
 * 例: 行=担当者 / 列=日付 / セル=その日の予定工数 (8h 上限チェック)。
 */
export type AnalysisHeatmap = {
  /** 列ラベル (例: 日付 'YYYY-MM-DD' or 'MM/DD')。 */
  columns: string[];
  /** 行群。 */
  rows: AnalysisHeatmapRow[];
  /** 値の単位サフィックス (例: 'h')。 */
  unit?: string;
};
