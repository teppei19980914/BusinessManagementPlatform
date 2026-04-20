import { describe, it, expect } from 'vitest';
import { THEMES, toSafeThemeId } from './index';

describe('toSafeThemeId (PR #72)', () => {
  it('THEMES のキーは透過的に返す', () => {
    for (const id of Object.keys(THEMES)) {
      expect(toSafeThemeId(id)).toBe(id);
    }
  });

  it('null / undefined / 空文字は "light" に丸める', () => {
    expect(toSafeThemeId(null)).toBe('light');
    expect(toSafeThemeId(undefined)).toBe('light');
    expect(toSafeThemeId('')).toBe('light');
  });

  it('未知の文字列も "light" に丸める (攻撃面を閉じる)', () => {
    expect(toSafeThemeId('rainbow')).toBe('light');
    expect(toSafeThemeId('<script>')).toBe('light');
    expect(toSafeThemeId('LIGHT')).toBe('light');
  });
});
