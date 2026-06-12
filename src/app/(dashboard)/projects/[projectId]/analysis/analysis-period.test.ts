import { describe, it, expect } from 'vitest';
import {
  resolveRanges,
  rangeForKind,
  isPeriodActive,
  clientTodayYmd,
  type AnalysisPeriod,
} from './analysis-period';

const TODAY = '2026-06-12';

describe('resolveRanges', () => {
  it('全期間: 過去・未来とも range なし', () => {
    expect(resolveRanges({ preset: 'all' }, TODAY)).toEqual({ past: undefined, future: undefined });
  });

  it('直近3ヶ月: 過去側=[today-3m, today] / 未来側=[null, today+3m]', () => {
    const r = resolveRanges({ preset: '3m' }, TODAY);
    expect(r.past).toEqual({ from: '2026-03-12', to: '2026-06-12' });
    expect(r.future).toEqual({ from: null, to: '2026-09-12' });
  });

  it('直近1ヶ月 / 6ヶ月 の月数が正しい', () => {
    expect(resolveRanges({ preset: '1m' }, TODAY).past).toEqual({
      from: '2026-05-12',
      to: '2026-06-12',
    });
    expect(resolveRanges({ preset: '6m' }, TODAY).future).toEqual({
      from: null,
      to: '2026-12-12',
    });
  });

  it('カスタム: 過去側は from/to そのまま、未来側は to のみ (from は null)', () => {
    const p: AnalysisPeriod = { preset: 'custom', customFrom: '2026-01-01', customTo: '2026-03-31' };
    const r = resolveRanges(p, TODAY);
    expect(r.past).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(r.future).toEqual({ from: null, to: '2026-03-31' });
  });

  it('カスタムで from/to とも空なら全期間扱い', () => {
    expect(resolveRanges({ preset: 'custom' }, TODAY)).toEqual({
      past: undefined,
      future: undefined,
    });
  });
});

describe('rangeForKind', () => {
  const ranges = resolveRanges({ preset: '3m' }, TODAY);
  it('past は過去側、future は未来側、none は undefined', () => {
    expect(rangeForKind('past', ranges)).toEqual(ranges.past);
    expect(rangeForKind('future', ranges)).toEqual(ranges.future);
    expect(rangeForKind('none', ranges)).toBeUndefined();
  });
});

describe('isPeriodActive', () => {
  it('全期間は false、プリセットは true', () => {
    expect(isPeriodActive({ preset: 'all' })).toBe(false);
    expect(isPeriodActive({ preset: '3m' })).toBe(true);
  });
  it('カスタムは from/to いずれかあれば true', () => {
    expect(isPeriodActive({ preset: 'custom' })).toBe(false);
    expect(isPeriodActive({ preset: 'custom', customTo: '2026-03-31' })).toBe(true);
  });
});

describe('clientTodayYmd', () => {
  it('ローカル日付を YYYY-MM-DD で返す', () => {
    expect(clientTodayYmd(new Date(2026, 5, 9))).toBe('2026-06-09');
    expect(clientTodayYmd(new Date(2026, 0, 1))).toBe('2026-01-01');
  });
});
