/**
 * tenant-time.ts の単体テスト (PR-4 / 2026-05-15)
 *
 * 検証観点:
 *   - formatTenantDate: TZ ローカルの YYYY-MM-DD を正しく取得
 *   - tenantCalendarDayDiff: 絶対経過時間ではなくカレンダー日差を返す
 *   - getTenantMonthStart / getTenantNextMonthStart: 月初境界を UTC Date で正確に
 *   - getTenantPreviousYearMonth: 前月 YYYY-MM 文字列 (年跨ぎ含む)
 */

import { describe, it, expect } from 'vitest';
import {
  formatTenantDate,
  tenantCalendarDayDiff,
  getTenantMonthStart,
  getTenantNextMonthStart,
  getTenantPreviousYearMonth,
  getTenantCurrentYearMonth,
  getTenantTodayString,
} from './tenant-time';

const TOKYO = 'Asia/Tokyo'; // UTC+9
const NEW_YORK = 'America/New_York'; // UTC-5 (or -4 DST)
const UTC = 'UTC';

describe('formatTenantDate', () => {
  it('Asia/Tokyo: UTC 15:00 は翌日扱い (= JST 00:00)', () => {
    expect(formatTenantDate(new Date('2026-02-01T15:00:00Z'), TOKYO)).toBe('2026-02-02');
  });

  it('Asia/Tokyo: UTC 14:59 は同日扱い (= JST 23:59)', () => {
    expect(formatTenantDate(new Date('2026-02-01T14:59:00Z'), TOKYO)).toBe('2026-02-01');
  });

  it('UTC: 同 UTC 日時はそのまま', () => {
    expect(formatTenantDate(new Date('2026-02-01T15:00:00Z'), UTC)).toBe('2026-02-01');
  });

  it('America/New_York: UTC 03:00 は前日扱い (NY EST = UTC-5)', () => {
    expect(formatTenantDate(new Date('2026-02-01T03:00:00Z'), NEW_YORK)).toBe('2026-01-31');
  });

  it('年跨ぎ: 12/31 23:59 JST = 12/31 (1/1 ではない)', () => {
    expect(formatTenantDate(new Date('2026-12-31T14:59:00Z'), TOKYO)).toBe('2026-12-31');
  });

  it('年跨ぎ: 12/31 15:00 UTC = 1/1 JST', () => {
    expect(formatTenantDate(new Date('2026-12-31T15:00:00Z'), TOKYO)).toBe('2027-01-01');
  });
});

describe('tenantCalendarDayDiff', () => {
  it('同 UTC 日内、Tokyo TZ で日付跨ぎ (JST 14:00 → 翌 09:00) → 1 日', () => {
    expect(
      tenantCalendarDayDiff(
        new Date('2026-02-01T05:00:00Z'), // 2026-02-01 14:00 JST
        new Date('2026-02-02T00:00:00Z'), // 2026-02-02 09:00 JST
        TOKYO,
      ),
    ).toBe(1);
  });

  it('絶対 90 日 + 1 ms 経過、JST 同日扱い → 90 日', () => {
    expect(
      tenantCalendarDayDiff(
        new Date('2026-02-01T15:00:00Z'), // JST 2026-02-02 00:00
        new Date('2026-05-02T15:00:01Z'), // JST 2026-05-03 00:00:01 → JST 日付は 2026-05-03
        TOKYO,
      ),
    ).toBe(90);
  });

  it('同日 (later == earlier の TZ ローカル日) → 0', () => {
    expect(
      tenantCalendarDayDiff(
        new Date('2026-02-01T05:00:00Z'),
        new Date('2026-02-01T14:00:00Z'),
        TOKYO,
      ),
    ).toBe(0);
  });

  it('Beginner 期限 90 日 (JST 14:00 作成 → 90 日後 09:00) → 90 日扱い', () => {
    // 旧仕様 (絶対経過時間) なら 89 日扱いだが、TZ カレンダー差で 90 になる
    const created = new Date('2026-02-01T05:00:00Z'); // JST 2026-02-01 14:00
    const checkAt = new Date('2026-05-02T00:00:00Z'); // JST 2026-05-02 09:00 = 90 日後
    expect(tenantCalendarDayDiff(created, checkAt, TOKYO)).toBe(90);
  });
});

describe('getTenantMonthStart', () => {
  it('Asia/Tokyo 月内 (2026-05-15 12:00 JST) → 2026-05-01 00:00 JST = 2026-04-30 15:00 UTC', () => {
    const result = getTenantMonthStart(new Date('2026-05-15T03:00:00Z'), TOKYO);
    expect(result.toISOString()).toBe('2026-04-30T15:00:00.000Z');
  });

  it('Asia/Tokyo 月初境界跨ぎ (2026-05-01 08:00 JST = 2026-04-30 23:00 UTC) → 2026-05-01 00:00 JST', () => {
    // 2026-05-01 08:00 JST 時点では「当月」= 2026年5月、月初 = 2026-05-01 00:00 JST = 2026-04-30 15:00 UTC
    const result = getTenantMonthStart(new Date('2026-04-30T23:00:00Z'), TOKYO);
    expect(result.toISOString()).toBe('2026-04-30T15:00:00.000Z');
  });

  it('UTC TZ: 通常通り Date.UTC ベースと一致', () => {
    const result = getTenantMonthStart(new Date('2026-05-15T12:00:00Z'), UTC);
    expect(result.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('getTenantNextMonthStart', () => {
  it('Asia/Tokyo: 5月 → 翌月 6/1 00:00 JST = 5/31 15:00 UTC', () => {
    const result = getTenantNextMonthStart(new Date('2026-05-15T03:00:00Z'), TOKYO);
    expect(result.toISOString()).toBe('2026-05-31T15:00:00.000Z');
  });

  it('Asia/Tokyo: 12月 → 翌年 1/1 00:00 JST', () => {
    const result = getTenantNextMonthStart(new Date('2026-12-15T03:00:00Z'), TOKYO);
    expect(result.toISOString()).toBe('2026-12-31T15:00:00.000Z');
  });

  it('UTC: 12月 → 翌年 1/1 UTC', () => {
    const result = getTenantNextMonthStart(new Date('2026-12-15T12:00:00Z'), UTC);
    expect(result.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('getTenantPreviousYearMonth', () => {
  it('Asia/Tokyo: 2026-05 → "2026-04"', () => {
    expect(getTenantPreviousYearMonth(new Date('2026-05-15T03:00:00Z'), TOKYO)).toBe('2026-04');
  });

  it('Asia/Tokyo: 2026-01 → "2025-12" (年跨ぎ)', () => {
    expect(getTenantPreviousYearMonth(new Date('2026-01-15T03:00:00Z'), TOKYO)).toBe('2025-12');
  });

  it('UTC: 2026-05 → "2026-04"', () => {
    expect(getTenantPreviousYearMonth(new Date('2026-05-15T03:00:00Z'), UTC)).toBe('2026-04');
  });
});

describe('getTenantCurrentYearMonth', () => {
  it('Asia/Tokyo: 2026-05-15 → "2026-05"', () => {
    expect(getTenantCurrentYearMonth(new Date('2026-05-15T03:00:00Z'), TOKYO)).toBe('2026-05');
  });

  it('Asia/Tokyo: 2026-12-31 23:30 JST (UTC 14:30) は当月扱い "2026-12"', () => {
    expect(getTenantCurrentYearMonth(new Date('2026-12-31T14:30:00Z'), TOKYO)).toBe('2026-12');
  });

  it('Asia/Tokyo: UTC 2026-12-31T15:30Z は JST 2027-01-01 00:30 → "2027-01" (年跨ぎ)', () => {
    expect(getTenantCurrentYearMonth(new Date('2026-12-31T15:30:00Z'), TOKYO)).toBe('2027-01');
  });

  it('UTC: 2026-05-15 → "2026-05"', () => {
    expect(getTenantCurrentYearMonth(new Date('2026-05-15T03:00:00Z'), UTC)).toBe('2026-05');
  });
});

describe('getTenantTodayString', () => {
  it('formatTenantDate と等価', () => {
    const now = new Date('2026-02-01T15:00:00Z');
    expect(getTenantTodayString(now, TOKYO)).toBe('2026-02-02');
  });
});
