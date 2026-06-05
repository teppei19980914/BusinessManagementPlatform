import { describe, it, expect } from 'vitest';
import { normalizeDate, normalizeDateWithFlag } from './date-normalize';

describe('date-normalize (ADR-0034 日付正規化 → YYYY-MM-DD)', () => {
  it('既に所定フォーマットはそのまま', () => {
    expect(normalizeDate('2026-06-04')).toBe('2026-06-04');
  });

  it('スラッシュ/ドット/空白区切りを変換', () => {
    expect(normalizeDate('2026/6/4')).toBe('2026-06-04');
    expect(normalizeDate('2026.6.4')).toBe('2026-06-04');
    expect(normalizeDate('2026 6 4')).toBe('2026-06-04');
    expect(normalizeDate('2026/06/04')).toBe('2026-06-04');
  });

  it('和文表記を変換', () => {
    expect(normalizeDate('2026年6月4日')).toBe('2026-06-04');
    expect(normalizeDate('2026 年 6 月 4 日')).toBe('2026-06-04');
    expect(normalizeDate('2026年12月31日')).toBe('2026-12-31');
  });

  it('ISO 日時は日付部のみ採用 (Backlog/kintone/Pleasanter 由来)', () => {
    expect(normalizeDate('2026-06-04T10:20:00Z')).toBe('2026-06-04');
    expect(normalizeDate('2021-05-25T00:00:00')).toBe('2021-05-25');
    expect(normalizeDate('2026-06-04 10:20:00')).toBe('2026-06-04');
  });

  it('8桁連結を変換', () => {
    expect(normalizeDate('20260604')).toBe('2026-06-04');
  });

  it('実在しない日付は null', () => {
    expect(normalizeDate('2026-13-01')).toBeNull();
    expect(normalizeDate('2026-02-30')).toBeNull();
    expect(normalizeDate('2026/0/5')).toBeNull();
  });

  it('曖昧な月日順 (M/D/YYYY) は変換せず null', () => {
    expect(normalizeDate('3/1/2016')).toBeNull();
    expect(normalizeDate('30/20/2016')).toBeNull();
  });

  it('空・null は null', () => {
    expect(normalizeDate('')).toBeNull();
    expect(normalizeDate('   ')).toBeNull();
    expect(normalizeDate(null)).toBeNull();
    expect(normalizeDate(undefined)).toBeNull();
  });

  describe('normalizeDateWithFlag — 変換が起きたかを返す', () => {
    it('変換なし', () => {
      expect(normalizeDateWithFlag('2026-06-04')).toEqual({ normalized: '2026-06-04', converted: false });
    });
    it('変換あり', () => {
      expect(normalizeDateWithFlag('2026/6/4')).toEqual({ normalized: '2026-06-04', converted: true });
      expect(normalizeDateWithFlag('2026年6月4日')).toEqual({ normalized: '2026-06-04', converted: true });
    });
    it('変換不能', () => {
      expect(normalizeDateWithFlag('xyz')).toEqual({ normalized: null, converted: false });
    });
  });
});
