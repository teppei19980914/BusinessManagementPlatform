import { describe, it, expect } from 'vitest';
import { nextNumericSlug, NUMERIC_SLUG_BASE } from './slug';

describe('nextNumericSlug', () => {
  it('既存数字 slug が無ければ BASE (100000) を返す', () => {
    expect(nextNumericSlug(0)).toBe(NUMERIC_SLUG_BASE);
  });

  it('既存最大値が BASE 未満でも BASE 以上を保証する', () => {
    expect(nextNumericSlug(42)).toBe(NUMERIC_SLUG_BASE);
    expect(nextNumericSlug(99999)).toBe(NUMERIC_SLUG_BASE);
  });

  it('既存最大値が BASE 以上なら +1 する (連番)', () => {
    expect(nextNumericSlug(100000)).toBe(100001);
    expect(nextNumericSlug(100042)).toBe(100043);
    expect(nextNumericSlug(999999)).toBe(1000000);
  });

  it('不正値 (NaN / 負数) は 0 扱いで BASE を返す', () => {
    expect(nextNumericSlug(Number.NaN)).toBe(NUMERIC_SLUG_BASE);
    expect(nextNumericSlug(-5)).toBe(NUMERIC_SLUG_BASE);
  });

  it('小数は切り捨てて採番する', () => {
    expect(nextNumericSlug(100100.9)).toBe(100101);
  });
});

describe('NUMERIC_SLUG_BASE', () => {
  it('6 桁の数字で、slug 規約 (3〜60 文字・英数字) を満たす', () => {
    expect(NUMERIC_SLUG_BASE).toBe(100000);
    expect(String(NUMERIC_SLUG_BASE)).toMatch(/^[0-9]{6}$/);
  });
});
