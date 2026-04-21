import { describe, it, expect } from 'vitest';
import { cn } from './utils';

describe('cn (class name merger)', () => {
  it('複数の文字列を空白区切りで結合する', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c');
  });

  it('falsy 値を除外する (undefined / null / false / 空文字)', () => {
    expect(cn('a', undefined, null, false, '', 'b')).toBe('a b');
  });

  it('配列を展開する', () => {
    expect(cn(['a', 'b'], 'c')).toBe('a b c');
  });

  it('真偽値オブジェクト形式で条件付きクラスを扱える (clsx 由来)', () => {
    expect(cn({ a: true, b: false, c: true })).toBe('a c');
  });

  it('tailwind の競合クラス (px-*) を後勝ちで merge する (twMerge 由来)', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });

  it('引数なしの場合は空文字を返す', () => {
    expect(cn()).toBe('');
  });
});
