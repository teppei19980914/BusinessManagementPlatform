import { describe, it, expect } from 'vitest';
import { THEME_DEFINITIONS, THEME_COLOR_SCHEMES, type ThemeTokens } from './theme-definitions';
import { THEMES } from './themes';

/**
 * このテストの目的 (PR #73 / PR #75 で src/config 配下に再配置):
 *   - 新しいテーマを `THEMES` に追加したが `THEME_DEFINITIONS` に追加し忘れた
 *   - トークンを追加したが一部テーマで値を設定し忘れた
 *   - 既存テーマに後から空文字や誤った値が混入した
 *   といった「横展開の漏れ」をビルド前に検出すること。
 */

// ThemeTokens の全キーを実行時検査用に列挙。
// 参照: src/config/theme-definitions.ts の型定義。ここでキーを列挙することで
// 型 → 実行時両面で「どのトークンが必須か」が一箇所に揃う。
const REQUIRED_TOKENS: (keyof ThemeTokens)[] = [
  'background', 'foreground',
  'card', 'cardForeground',
  'popover', 'popoverForeground',
  'primary', 'primaryForeground',
  'secondary', 'secondaryForeground',
  'muted', 'mutedForeground',
  'accent', 'accentForeground',
  'destructive', 'destructiveForeground',
  'border', 'input', 'ring',
  'chart1', 'chart2', 'chart3', 'chart4', 'chart5',
  'sidebar', 'sidebarForeground',
  'sidebarPrimary', 'sidebarPrimaryForeground',
  'sidebarAccent', 'sidebarAccentForeground',
  'sidebarBorder', 'sidebarRing',
  // PR #76 Phase 2 で追加されたセマンティック色
  'info', 'infoForeground',
  'success', 'successForeground',
  'warning', 'warningForeground',
  'milestoneMarker',
];

describe('THEME_DEFINITIONS', () => {
  it('THEMES に列挙された全テーマに定義が存在する (ID 追加漏れ検出)', () => {
    const catalogIds = Object.keys(THEMES).sort();
    const definitionIds = Object.keys(THEME_DEFINITIONS).sort();
    expect(definitionIds).toEqual(catalogIds);
  });

  it('各テーマが ThemeTokens の全キーを非空で持つ (トークン欠落検出)', () => {
    for (const [themeId, tokens] of Object.entries(THEME_DEFINITIONS)) {
      for (const key of REQUIRED_TOKENS) {
        const value = (tokens as ThemeTokens)[key];
        expect(value, `${themeId}.${key} must be defined`).toBeTruthy();
        expect(typeof value, `${themeId}.${key} must be string`).toBe('string');
        expect(value.length, `${themeId}.${key} must not be empty`).toBeGreaterThan(0);
      }
    }
  });

  it('余計なキーが混入していない (型にないトークンのリーク検出)', () => {
    for (const [themeId, tokens] of Object.entries(THEME_DEFINITIONS)) {
      const actualKeys = Object.keys(tokens).sort();
      const expectedKeys = [...REQUIRED_TOKENS].sort();
      expect(actualKeys, `${themeId} keys mismatch`).toEqual(expectedKeys);
    }
  });

  it('light テーマは既定値として存在する', () => {
    expect(THEME_DEFINITIONS.light).toBeDefined();
    expect(THEME_DEFINITIONS.light.background).toBeTruthy();
    expect(THEME_DEFINITIONS.light.foreground).toBeTruthy();
  });
});

describe('THEME_COLOR_SCHEMES (PR #78)', () => {
  it('THEMES の全テーマに color-scheme 値が定義されている (追加漏れ検出)', () => {
    const catalogIds = Object.keys(THEMES).sort();
    const schemeIds = Object.keys(THEME_COLOR_SCHEMES).sort();
    expect(schemeIds).toEqual(catalogIds);
  });

  it('color-scheme 値は light か dark のいずれかである', () => {
    for (const [themeId, scheme] of Object.entries(THEME_COLOR_SCHEMES)) {
      expect(['light', 'dark']).toContain(scheme);
      expect(scheme, `${themeId}.colorScheme is empty`).toBeTruthy();
    }
  });

  it('dark テーマのみ dark、それ以外は全て light (背景輝度との整合性)', () => {
    expect(THEME_COLOR_SCHEMES.dark).toBe('dark');
    expect(THEME_COLOR_SCHEMES.light).toBe('light');
    // pastel / pop はいずれも明るい背景なので light
    for (const id of Object.keys(THEME_COLOR_SCHEMES)) {
      if (id === 'dark') continue;
      expect(
        THEME_COLOR_SCHEMES[id as keyof typeof THEME_COLOR_SCHEMES],
        `${id} should be 'light' (only 'dark' theme uses dark color-scheme)`,
      ).toBe('light');
    }
  });
});
