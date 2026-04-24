import { describe, it, expect } from 'vitest';
import { formatDateTime, formatDate, formatDateTimeFull } from './format';

/**
 * PR #117 → PR #118 (2026-04-24):
 *   - PR #117: JST 固定タイムゾーン (Intl.DateTimeFormat) に統一
 *   - PR #118: { timeZone, locale } オプション化。引数なしは DEFAULT に FB。
 * Server (UTC) / Client (JST) で同じ結果を返すことがハイドレーション安全性の要件。
 */

describe('formatDateTime (引数なし = DEFAULT TZ/locale)', () => {
  it('UTC 15:00 は JST 翌日 00:00 になる (DEFAULT=Asia/Tokyo)', () => {
    expect(formatDateTime('2026-04-23T15:00:00Z')).toBe('2026-04-24 00:00');
  });

  it('UTC 00:00 は JST 09:00 (同日)', () => {
    expect(formatDateTime('2026-04-23T00:00:00Z')).toBe('2026-04-23 09:00');
  });

  it('runtime TZ に依存しない (同じ input は常に同じ output)', () => {
    const a = formatDateTime('2026-04-23T12:34:56Z');
    const b = formatDateTime('2026-04-23T12:34:56Z');
    expect(a).toBe(b);
  });

  it('1 桁の月日・時分をゼロ埋めする (JST 09:05)', () => {
    expect(formatDateTime('2026-01-03T00:05:00Z')).toBe('2026-01-03 09:05');
  });

  it('年跨ぎ (UTC 2026-12-31T23:59 → JST 2027-01-01 08:59)', () => {
    expect(formatDateTime('2026-12-31T23:59:00Z')).toBe('2027-01-01 08:59');
  });
});

describe('formatDateTime (明示的な timeZone/locale 指定)', () => {
  it('UTC 15:00 は America/New_York で同日 11:00 (DST 期間)', () => {
    // 2026-04-24 は EDT (UTC-4)
    expect(formatDateTime('2026-04-24T15:00:00Z', { timeZone: 'America/New_York' }))
      .toBe('2026-04-24 11:00');
  });

  it('UTC 指定では変換なし', () => {
    expect(formatDateTime('2026-04-24T15:30:00Z', { timeZone: 'UTC' }))
      .toBe('2026-04-24 15:30');
  });

  it('null を渡すと DEFAULT にフォールバック (システムデフォルト)', () => {
    const a = formatDateTime('2026-04-23T15:00:00Z', { timeZone: null, locale: null });
    const b = formatDateTime('2026-04-23T15:00:00Z');
    expect(a).toBe(b);
  });

  it('空文字列 / 空白のみも DEFAULT にフォールバック', () => {
    const a = formatDateTime('2026-04-23T15:00:00Z', { timeZone: '', locale: '   ' });
    const b = formatDateTime('2026-04-23T15:00:00Z');
    expect(a).toBe(b);
  });
});

describe('formatDate (引数なし = DEFAULT)', () => {
  it('UTC 15:00 は JST 翌日の日付', () => {
    expect(formatDate('2026-04-23T15:00:00Z')).toBe('2026/04/24');
  });

  it('UTC 00:00 は同日付 JST', () => {
    expect(formatDate('2026-04-23T00:00:00Z')).toBe('2026/04/23');
  });
});

describe('formatDate (locale 指定)', () => {
  it('en-US は月/日/年 の順で / 区切り', () => {
    // 2026-04-24 15:00 UTC → 2026-04-24 11:00 EDT
    expect(formatDate('2026-04-24T15:00:00Z', { locale: 'en-US', timeZone: 'America/New_York' }))
      .toBe('04/24/2026');
  });
});

describe('formatDateTimeFull (引数なし = DEFAULT)', () => {
  it('ja-JP locale で / 区切り', () => {
    expect(formatDateTimeFull('2026-04-23T00:00:00Z')).toBe('2026/04/23 09:00');
  });
});
