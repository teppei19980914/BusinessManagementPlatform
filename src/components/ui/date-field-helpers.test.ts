import { describe, it, expect } from 'vitest';
import {
  buildMonthGrid,
  formatYMD,
  parseYMD,
  todayString,
} from './date-field-helpers';

describe('todayString', () => {
  it('与えられた Date をローカル時刻ベースで YYYY-MM-DD に整形する', () => {
    expect(todayString(new Date(2026, 0, 1))).toBe('2026-01-01');
    expect(todayString(new Date(2026, 11, 9))).toBe('2026-12-09');
    expect(todayString(new Date(2026, 3, 20))).toBe('2026-04-20');
  });

  it('引数省略時も YYYY-MM-DD 形式 (10 文字) を返す', () => {
    const s = todayString();
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('parseYMD', () => {
  it('正常な YYYY-MM-DD をパースする', () => {
    expect(parseYMD('2026-04-20')).toEqual({ y: 2026, m: 4, d: 20 });
    expect(parseYMD('2000-01-01')).toEqual({ y: 2000, m: 1, d: 1 });
    expect(parseYMD('2099-12-31')).toEqual({ y: 2099, m: 12, d: 31 });
  });

  it('不正な形式は null を返す (XSS / 意図せぬ入力のガード)', () => {
    expect(parseYMD('')).toBeNull();
    expect(parseYMD('2026/04/20')).toBeNull();
    expect(parseYMD('abc')).toBeNull();
    expect(parseYMD('2026-4-20')).toBeNull(); // ゼロ埋めなし
    expect(parseYMD('2026-04-20T10:00')).toBeNull(); // 時刻付き
  });

  it('範囲外の月/日は null を返す', () => {
    expect(parseYMD('2026-00-10')).toBeNull();
    expect(parseYMD('2026-13-10')).toBeNull();
    expect(parseYMD('2026-04-00')).toBeNull();
    expect(parseYMD('2026-04-32')).toBeNull();
  });
});

describe('formatYMD', () => {
  it('ゼロパディング込みで YYYY-MM-DD を組み立てる', () => {
    expect(formatYMD(2026, 4, 20)).toBe('2026-04-20');
    expect(formatYMD(2026, 1, 1)).toBe('2026-01-01');
    expect(formatYMD(2026, 12, 31)).toBe('2026-12-31');
  });
});

describe('buildMonthGrid', () => {
  it('2026 年 4 月 (1 日=水曜) の 1 行目は [日,月,火 が null, 水=1, 木=2, 金=3, 土=4] になる', () => {
    const grid = buildMonthGrid(2026, 4);
    expect(grid[0]).toEqual([null, null, null, 1, 2, 3, 4]);
  });

  it('すべての行が 7 セルであり、総日数が正しい', () => {
    const grid = buildMonthGrid(2026, 4); // 4 月 = 30 日
    for (const row of grid) expect(row.length).toBe(7);
    const actualDays = grid.flat().filter((v): v is number => typeof v === 'number');
    expect(actualDays.length).toBe(30);
    expect(actualDays[0]).toBe(1);
    expect(actualDays[actualDays.length - 1]).toBe(30);
  });

  it('2026 年 2 月 (28 日) / 2024 年 2 月 (閏年 29 日) の日数差が正しく反映される', () => {
    const normalYear = buildMonthGrid(2026, 2).flat().filter(Boolean).length;
    const leapYear = buildMonthGrid(2024, 2).flat().filter(Boolean).length;
    expect(normalYear).toBe(28);
    expect(leapYear).toBe(29);
  });

  it('月初が日曜の月 (2026 年 3 月 1 日=日) は 1 行目が [1, 2, 3, 4, 5, 6, 7] になる', () => {
    const grid = buildMonthGrid(2026, 3);
    expect(grid[0]).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
