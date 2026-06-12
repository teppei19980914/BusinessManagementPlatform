/**
 * 分析 API の対象期間 (range) クエリパーサ。
 *
 * 分析タブのツールバーで選んだ期間を `?from=YYYY-MM-DD&to=YYYY-MM-DD` で受け取り、
 * `AnalyticsRange` に変換する。各分析サービスがパネルの性質ごとに解釈する
 * (過去向き = [from,to] で絞る / 未来向き = to で終端を絞る)。
 *
 * 防御方針: 形式が YYYY-MM-DD でない値は黙って無視する (不正入力で 500 にしない)。
 * from / to の両方が無ければ undefined を返し、サービスは全期間として扱う。
 */

import type { AnalyticsRange } from '@/services/analytics.service';

/** YYYY-MM-DD (厳密) の判定。暦として妥当かまでは見ない (上限/下限の文字列比較で使うため)。 */
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function sanitize(value: string | null): string | undefined {
  if (value && YMD.test(value)) return value;
  return undefined;
}

/**
 * URLSearchParams から `from` / `to` を取り出し AnalyticsRange を作る。
 * どちらも妥当でなければ undefined (= 全期間)。
 */
export function parseAnalyticsRange(searchParams: URLSearchParams): AnalyticsRange | undefined {
  const from = sanitize(searchParams.get('from'));
  const to = sanitize(searchParams.get('to'));
  if (from === undefined && to === undefined) return undefined;
  return { from: from ?? null, to: to ?? null };
}
