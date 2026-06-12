/**
 * 分析タブ ツールバーの「対象期間」モデル (純関数・テスト可能)。
 *
 * 期間プリセットを、パネルの性質ごとの `AnalyticsRange` (過去側 / 未来側) に解決する。
 *   - 過去向きパネル ('past'): [today-Nヶ月, today] で対象を絞る。
 *   - 未来向きパネル ('future'): [today, today+Nヶ月] (起点は常に本日。to で未来を絞る)。
 *   - 'none' パネル (作業負担): 期間の影響を受けない (range = undefined)。
 *
 * カスタム期間は from/to をそのまま過去側に、未来側は [today, to] (未来部分のみ) に適用する。
 * 「全期間」は過去側・未来側とも range なし (= 無制限)。
 */

import type { AnalyticsRange } from '@/services/analytics.service';
import type { AnalysisRangeKind } from './analysis-panels';

/** 期間プリセット。 */
export type PeriodPreset = 'all' | '1m' | '3m' | '6m' | 'custom';

/** ツールバーで保持する期間状態。 */
export type AnalysisPeriod = {
  preset: PeriodPreset;
  /** preset='custom' のときの下限 (YYYY-MM-DD)。 */
  customFrom?: string | null;
  /** preset='custom' のときの上限 (YYYY-MM-DD)。 */
  customTo?: string | null;
};

/** プリセットの月数 (custom/all は null)。 */
const PRESET_MONTHS: Record<PeriodPreset, number | null> = {
  all: null,
  '1m': 1,
  '3m': 3,
  '6m': 6,
  custom: null,
};

/** YYYY-MM-DD を delta ヶ月ずらす (UTC 基準。月末はみ出しは Date が正規化)。 */
function shiftMonths(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, d)).toISOString().slice(0, 10);
}

/** 過去側 / 未来側の range をまとめた解決結果。 */
export type ResolvedRanges = {
  /** 過去向きパネル用。undefined = 全期間。 */
  past?: AnalyticsRange;
  /** 未来向きパネル用。undefined = 全期間。 */
  future?: AnalyticsRange;
};

/** 期間状態 + 本日 (YYYY-MM-DD) から過去側 / 未来側 range を解決する。 */
export function resolveRanges(period: AnalysisPeriod, todayYmd: string): ResolvedRanges {
  if (period.preset === 'all') return { past: undefined, future: undefined };

  if (period.preset === 'custom') {
    const from = period.customFrom || null;
    const to = period.customTo || null;
    if (from == null && to == null) return { past: undefined, future: undefined };
    return {
      past: { from, to },
      // 未来側は本日以降のみ意味を持つため from は無視し、to だけ効かせる。
      future: { from: null, to },
    };
  }

  const months = PRESET_MONTHS[period.preset];
  if (months == null) return { past: undefined, future: undefined };
  return {
    past: { from: shiftMonths(todayYmd, -months), to: todayYmd },
    future: { from: null, to: shiftMonths(todayYmd, months) },
  };
}

/** パネルの rangeKind に対応する range を取り出す。'none' は常に undefined。 */
export function rangeForKind(
  kind: AnalysisRangeKind,
  ranges: ResolvedRanges,
): AnalyticsRange | undefined {
  if (kind === 'past') return ranges.past;
  if (kind === 'future') return ranges.future;
  return undefined;
}

/** 期間が指定されているか (全期間でないか)。注記表示の判定に使う。 */
export function isPeriodActive(period: AnalysisPeriod): boolean {
  if (period.preset === 'all') return false;
  if (period.preset === 'custom') return Boolean(period.customFrom || period.customTo);
  return true;
}

/** ローカル日付の YYYY-MM-DD を返す (クライアントの「本日」)。 */
export function clientTodayYmd(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
