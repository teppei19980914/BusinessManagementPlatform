import { describe, it, expect } from 'vitest';
import { updateThemeSchema } from './theme';
import { THEMES } from '@/types';

describe('updateThemeSchema (PR #72)', () => {
  it('THEMES のキー全てを受理する', () => {
    for (const id of Object.keys(THEMES)) {
      const result = updateThemeSchema.safeParse({ theme: id });
      expect(result.success, `theme=${id} should be valid`).toBe(true);
    }
  });

  it('既定テーマ "light" を受理する', () => {
    expect(updateThemeSchema.safeParse({ theme: 'light' }).success).toBe(true);
  });

  it('未知のテーマ ID は拒否する (DB 汚染防止)', () => {
    expect(updateThemeSchema.safeParse({ theme: 'rainbow' }).success).toBe(false);
    expect(updateThemeSchema.safeParse({ theme: '' }).success).toBe(false);
    expect(updateThemeSchema.safeParse({ theme: 'LIGHT' }).success).toBe(false); // 大文字小文字区別
  });

  it('theme フィールド欠如や型不一致は拒否する', () => {
    expect(updateThemeSchema.safeParse({}).success).toBe(false);
    expect(updateThemeSchema.safeParse({ theme: 123 }).success).toBe(false);
    expect(updateThemeSchema.safeParse({ theme: null }).success).toBe(false);
    expect(updateThemeSchema.safeParse(null).success).toBe(false);
  });
});
