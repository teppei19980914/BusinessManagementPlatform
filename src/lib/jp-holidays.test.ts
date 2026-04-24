import { describe, it, expect } from 'vitest';
import {
  getJapaneseHoliday,
  isJapaneseHoliday,
  getJapaneseHolidaysBetween,
} from './jp-holidays';

/**
 * PR #125: 日本祝日判定のユニットテスト。
 * データソース: @holiday-jp/holiday_jp (内閣府公示ベース)
 */

describe('getJapaneseHoliday', () => {
  it('固定祝日: 元日 (1/1) を判定する', () => {
    expect(getJapaneseHoliday('2026-01-01')).toBe('元日');
  });

  it('固定祝日: 建国記念の日 (2/11) を判定する', () => {
    expect(getJapaneseHoliday('2026-02-11')).toBe('建国記念の日');
  });

  it('固定祝日: こどもの日 (5/5) を判定する', () => {
    expect(getJapaneseHoliday('2026-05-05')).toBe('こどもの日');
  });

  it('移動祝日: 2026 年の成人の日 (1 月第 2 月曜 = 1/12) を判定する', () => {
    expect(getJapaneseHoliday('2026-01-12')).toBe('成人の日');
  });

  it('移動祝日: 2026 年の敬老の日 (9 月第 3 月曜 = 9/21) を判定する', () => {
    expect(getJapaneseHoliday('2026-09-21')).toBe('敬老の日');
  });

  it('祝日でない日は null を返す', () => {
    expect(getJapaneseHoliday('2026-04-24')).toBeNull();
    expect(getJapaneseHoliday('2026-06-15')).toBeNull();
  });

  it('Date インスタンスも受理する', () => {
    expect(getJapaneseHoliday(new Date(2026, 0, 1))).toBe('元日'); // JS Date: month=0 が 1 月
  });
});

describe('isJapaneseHoliday', () => {
  it('祝日なら true', () => {
    expect(isJapaneseHoliday('2026-01-01')).toBe(true);
  });

  it('祝日でないなら false', () => {
    expect(isJapaneseHoliday('2026-04-24')).toBe(false);
  });
});

describe('getJapaneseHolidaysBetween', () => {
  it('2026 年ゴールデンウィーク期間内の祝日を返す', () => {
    const holidays = getJapaneseHolidaysBetween('2026-04-29', '2026-05-05');
    expect(holidays.map((h) => h.name)).toEqual([
      '昭和の日',      // 4/29
      '憲法記念日',    // 5/3
      'みどりの日',    // 5/4
      'こどもの日',    // 5/5
    ]);
  });

  it('祝日の無い期間は空配列を返す', () => {
    const holidays = getJapaneseHolidaysBetween('2026-06-10', '2026-06-20');
    expect(holidays).toEqual([]);
  });

  it('開始・終了を両端含む', () => {
    const holidays = getJapaneseHolidaysBetween('2026-01-01', '2026-01-01');
    expect(holidays).toEqual([{ date: '2026-01-01', name: '元日' }]);
  });

  it('結果は日付昇順でソートされる', () => {
    const holidays = getJapaneseHolidaysBetween('2026-01-01', '2026-12-31');
    for (let i = 1; i < holidays.length; i++) {
      expect(holidays[i].date >= holidays[i - 1].date).toBe(true);
    }
  });
});
