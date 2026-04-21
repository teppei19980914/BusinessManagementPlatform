import { describe, it, expect } from 'vitest';
import { formatDateTime } from './format';

describe('formatDateTime', () => {
  it('ISO 文字列を YYYY-MM-DD HH:MM 形式に整形する', () => {
    // ローカルタイムゾーンでの表現を確認するため、固定 ISO を与えて
    // 年月日部分のフォーマットのみ検証する (時刻は TZ 依存)
    const s = formatDateTime('2026-04-21T09:05:00Z');
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('1 桁の月日・時分をゼロ埋めする', () => {
    const d = new Date(2026, 0, 3, 4, 5); // 2026-01-03 04:05 local
    const s = formatDateTime(d.toISOString());
    expect(s).toBe('2026-01-03 04:05');
  });

  it('12 月 31 日の年跨ぎを正しく扱う', () => {
    const d = new Date(2026, 11, 31, 23, 59); // 2026-12-31 23:59 local
    expect(formatDateTime(d.toISOString())).toBe('2026-12-31 23:59');
  });
});
