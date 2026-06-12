import { describe, it, expect } from 'vitest';
import { parseAnalyticsRange } from './analytics-range';

/** クエリ文字列から URLSearchParams を作るヘルパ。 */
const sp = (q: string) => new URLSearchParams(q);

describe('parseAnalyticsRange', () => {
  it('from/to の両方が無ければ undefined (全期間)', () => {
    expect(parseAnalyticsRange(sp(''))).toBeUndefined();
  });

  it('正しい YYYY-MM-DD の from/to を取り出す', () => {
    expect(parseAnalyticsRange(sp('from=2026-06-01&to=2026-06-30'))).toEqual({
      from: '2026-06-01',
      to: '2026-06-30',
    });
  });

  it('片側だけ指定なら他方は null', () => {
    expect(parseAnalyticsRange(sp('to=2026-06-30'))).toEqual({ from: null, to: '2026-06-30' });
    expect(parseAnalyticsRange(sp('from=2026-06-01'))).toEqual({ from: '2026-06-01', to: null });
  });

  it('形式不正 (YYYY/MM/DD・短い・非数字) は無視する', () => {
    expect(parseAnalyticsRange(sp('from=2026/06/01&to=bad'))).toBeUndefined();
    expect(parseAnalyticsRange(sp('from=2026-6-1'))).toBeUndefined();
    // 妥当な to のみ残る
    expect(parseAnalyticsRange(sp('from=xxx&to=2026-06-30'))).toEqual({
      from: null,
      to: '2026-06-30',
    });
  });
});
