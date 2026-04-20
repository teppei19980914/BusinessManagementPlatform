/**
 * テーマ定義モジュールのエントリ (PR #73)。
 *
 * 利用側は `@/lib/themes` からインポートする:
 *   import { generateThemeCss, THEME_DEFINITIONS, type ThemeTokens } from '@/lib/themes';
 */

export { THEME_DEFINITIONS, type ThemeTokens } from './definitions';
export { generateThemeCss, tokenToCssVarName } from './generate-css';
