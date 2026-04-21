import { describe, it, expect } from 'vitest';
import { generateThemeCss, tokenToCssVarName } from './generate-css';
import { THEME_DEFINITIONS, THEME_COLOR_SCHEMES } from '@/config/theme-definitions';
import { THEMES } from '@/types';

describe('tokenToCssVarName', () => {
  it('camelCase を --kebab-case CSS 変数名に変換する', () => {
    expect(tokenToCssVarName('background')).toBe('--background');
    expect(tokenToCssVarName('cardForeground')).toBe('--card-foreground');
    expect(tokenToCssVarName('sidebarPrimaryForeground')).toBe('--sidebar-primary-foreground');
  });

  it('末尾数字は ハイフン区切り にする (chart1 → --chart-1)', () => {
    expect(tokenToCssVarName('chart1')).toBe('--chart-1');
    expect(tokenToCssVarName('chart5')).toBe('--chart-5');
  });
});

describe('generateThemeCss', () => {
  const css = generateThemeCss();

  it('全テーマ ID がセレクタとして出力に含まれる', () => {
    expect(css).toContain(':root,\n[data-theme="light"]');
    for (const id of Object.keys(THEMES)) {
      if (id === 'light') continue; // light は :root と合同セレクタ
      expect(css, `[data-theme="${id}"] must be present`).toContain(`[data-theme="${id}"]`);
    }
  });

  it('各テーマの全トークンが CSS 変数として出力される', () => {
    for (const [themeId, tokens] of Object.entries(THEME_DEFINITIONS)) {
      for (const [tokenKey, tokenValue] of Object.entries(tokens)) {
        const cssVar = tokenToCssVarName(tokenKey);
        // 変数名と値のペアが CSS に含まれる (順序やインデントには依存しない)
        expect(
          css,
          `${themeId}: ${cssVar}: ${tokenValue}; が見つからない`,
        ).toContain(`${cssVar}: ${tokenValue};`);
      }
    }
  });

  it('生成 CSS は { と } の数がバランスしている (中括弧欠落/余剰検出)', () => {
    const openCount = (css.match(/\{/g) || []).length;
    const closeCount = (css.match(/\}/g) || []).length;
    expect(openCount).toBe(closeCount);
    // テーマ数分のブロックが生成されている
    expect(openCount).toBe(Object.keys(THEMES).length);
  });

  it('純粋関数: 複数回呼び出しても同じ出力を返す', () => {
    expect(generateThemeCss()).toBe(generateThemeCss());
  });

  it('CSS に HTML 危険文字 (<, >, &) が混入していない (XSS / パーサ事故防止)', () => {
    // テーマ値の oklch(...) にこれらは含まれないはず。もし混入したら警告する。
    expect(css).not.toMatch(/[<>&]/);
  });

  it('PR #78: 全テーマで color-scheme 宣言が出力される', () => {
    // 各テーマブロック内に `color-scheme: <value>;` が含まれていること。
    // ブラウザネイティブの <select> ドロップダウン等のレンダリングモードを正しく伝えるため。
    for (const [id, scheme] of Object.entries(THEME_COLOR_SCHEMES)) {
      expect(
        css,
        `[data-theme="${id}"] block must contain color-scheme: ${scheme};`,
      ).toContain(`color-scheme: ${scheme};`);
    }
  });
});
