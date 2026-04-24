import { describe, it, expect } from 'vitest';
import { formatDateTime, formatDate, formatDateTimeFull } from './format';

/**
 * PR #117 (2026-04-24): JST 固定タイムゾーンでの描画を検証。
 * Server (UTC) / Client (JST) で同じ結果を返すことがハイドレーション安全性の要件。
 */
describe('formatDateTime (JST 固定)', () => {
  it('UTC 15:00 は JST 翌日 00:00 になる', () => {
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

describe('formatDate (JST 日付のみ)', () => {
  it('UTC 15:00 は JST 翌日の日付', () => {
    expect(formatDate('2026-04-23T15:00:00Z')).toBe('2026/04/24');
  });

  it('UTC 00:00 は同日付 JST', () => {
    expect(formatDate('2026-04-23T00:00:00Z')).toBe('2026/04/23');
  });
});

describe('formatDateTimeFull (JST 詳細日時、tooltip 等)', () => {
  it('ja-JP locale で / 区切り', () => {
    expect(formatDateTimeFull('2026-04-23T00:00:00Z')).toBe('2026/04/23 09:00');
  });
});
