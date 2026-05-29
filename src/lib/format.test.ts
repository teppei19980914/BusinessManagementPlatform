import { describe, it, expect } from 'vitest';
import { formatDateTime, formatDate, formatDateTimeFull, formatDateOnly } from './format';

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

describe('formatDateOnly (date-only YYYY-MM-DD の locale 表示、TZ シフトなし)', () => {
  it('ja-JP のデフォルトで 2026/05/15 形式 (/ 区切り)', () => {
    expect(formatDateOnly('2026-05-15')).toBe('2026/05/15');
  });

  it('en-US は MM/DD/YYYY 形式', () => {
    expect(formatDateOnly('2026-05-15', { locale: 'en-US' })).toBe('05/15/2026');
  });

  it('1 桁月日のゼロ埋め (ja-JP)', () => {
    expect(formatDateOnly('2026-01-03')).toBe('2026/01/03');
  });

  it('TZ 引数を渡しても無視され前日にずれない (regression guard)', () => {
    // feat/gantt-initial-scroll-and-locale: 旧 formatDate('2026-05-15') では America/New_York で
    //   2026-05-14 表示にずれていた。formatDateOnly では TZ='UTC' 固定により常に同じ Y/M/D を保つ。
    expect(formatDateOnly('2026-05-15', { locale: 'en-US' })).toBe('05/15/2026');
    // locale を指定せずデフォルトでも shift しない
    expect(formatDateOnly('2026-05-15')).toBe('2026/05/15');
  });

  it('locale 未指定 / null / 空文字は DEFAULT にフォールバック', () => {
    const a = formatDateOnly('2026-05-15');
    const b = formatDateOnly('2026-05-15', { locale: null });
    const c = formatDateOnly('2026-05-15', { locale: '' });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('不正な入力 (空 / 形式不正) は空文字を返す', () => {
    expect(formatDateOnly('')).toBe('');
    expect(formatDateOnly('invalid')).toBe('');
    expect(formatDateOnly('2026/05/15')).toBe(''); // 区切りが - でない
    expect(formatDateOnly('2026-5-15')).toBe(''); // ゼロ埋めなし
  });

  it('意味的に不正な月日 (13月、99日、2月30日 等) は空文字を返す (繰り上げを許さない厳密検証)', () => {
    expect(formatDateOnly('2026-13-01')).toBe(''); // 13 月
    expect(formatDateOnly('2026-00-01')).toBe(''); // 0 月
    expect(formatDateOnly('2026-01-00')).toBe(''); // 0 日
    expect(formatDateOnly('2026-01-32')).toBe(''); // 32 日
    expect(formatDateOnly('2026-02-30')).toBe(''); // 2 月 30 日 (実在しない)
    expect(formatDateOnly('2025-02-29')).toBe(''); // 平年の 2/29 (実在しない)
    expect(formatDateOnly('2026-04-31')).toBe(''); // 4 月 31 日 (4月は30日まで)
  });

  it('うるう年 2/29 を正しく扱う', () => {
    expect(formatDateOnly('2024-02-29')).toBe('2024/02/29');
  });

  it('年跨ぎ前後で TZ シフトせず正しい年/月/日を返す', () => {
    expect(formatDateOnly('2026-12-31', { locale: 'ja-JP' })).toBe('2026/12/31');
    expect(formatDateOnly('2027-01-01', { locale: 'ja-JP' })).toBe('2027/01/01');
  });
});
