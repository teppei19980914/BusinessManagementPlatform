import { describe, it, expect } from 'vitest';
import { toDisplay, normalizeNumberInput } from './number-input';

describe('toDisplay', () => {
  it('min 以上の数値は文字列化して返す', () => {
    expect(toDisplay(1, 1)).toBe('1');
    expect(toDisplay(50, 1)).toBe('50');
    expect(toDisplay(100, 1)).toBe('100');
    expect(toDisplay(5.5, 1)).toBe('5.5');
  });

  it('min 未満の値は空文字を返す（「0 が消えない」バグの解消）', () => {
    expect(toDisplay(0, 1)).toBe('');
    expect(toDisplay(0.5, 1)).toBe('');
    expect(toDisplay(-1, 1)).toBe('');
  });

  it('NaN / Infinity は空文字を返す', () => {
    expect(toDisplay(NaN, 1)).toBe('');
    expect(toDisplay(Infinity, 1)).toBe('');
    expect(toDisplay(-Infinity, 1)).toBe('');
  });

  it('min=0 の場合、0 は有効値として扱い "0" を返す', () => {
    expect(toDisplay(0, 0)).toBe('0');
    expect(toDisplay(5, 0)).toBe('5');
    expect(toDisplay(-1, 0)).toBe('');
  });
});

describe('normalizeNumberInput', () => {
  it('有効な数値テキスト（>= min）はその値と文字列を返す', () => {
    expect(normalizeNumberInput('10', 1)).toEqual({ value: 10, display: '10' });
    expect(normalizeNumberInput('1', 1)).toEqual({ value: 1, display: '1' });
    expect(normalizeNumberInput('5.5', 1)).toEqual({ value: 5.5, display: '5.5' });
  });

  it('空文字は無効値扱いで value=0・display=空 を返す', () => {
    expect(normalizeNumberInput('', 1)).toEqual({ value: 0, display: '' });
  });

  it('非数値テキストは無効値扱いで value=0・display=空 を返す（要件: 非数値 → 0 に再描画）', () => {
    expect(normalizeNumberInput('abc', 1)).toEqual({ value: 0, display: '' });
    expect(normalizeNumberInput('1a', 1)).toEqual({ value: 0, display: '' });
    expect(normalizeNumberInput('--', 1)).toEqual({ value: 0, display: '' });
  });

  it('min 未満の値（0 以下）は無効値扱いで value=0・display=空 を返す（要件: 0 以下 → 0 に再描画）', () => {
    expect(normalizeNumberInput('0', 1)).toEqual({ value: 0, display: '' });
    expect(normalizeNumberInput('-1', 1)).toEqual({ value: 0, display: '' });
    expect(normalizeNumberInput('0.5', 1)).toEqual({ value: 0, display: '' });
  });

  it('max を超える値は max に丸める', () => {
    expect(normalizeNumberInput('150', 1, 100)).toEqual({ value: 100, display: '100' });
    expect(normalizeNumberInput('99', 1, 100)).toEqual({ value: 99, display: '99' });
  });

  it('前後空白つきテキストも Number() の慣習通り処理される', () => {
    expect(normalizeNumberInput('  10  ', 1)).toEqual({ value: 10, display: '10' });
  });

  it('min=0 の場合、0 は有効値として通る', () => {
    expect(normalizeNumberInput('0', 0)).toEqual({ value: 0, display: '0' });
    expect(normalizeNumberInput('-1', 0)).toEqual({ value: 0, display: '' });
  });
});
