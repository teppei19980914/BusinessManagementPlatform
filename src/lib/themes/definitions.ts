/**
 * 後方互換 re-export (PR #75 Phase 1 で実体は `src/config/theme-definitions.ts` に移動)。
 * 新規コードは `@/config/theme-definitions` もしくは `@/config` から import すること。
 */
export { THEME_DEFINITIONS, type ThemeTokens } from '@/config/theme-definitions';
