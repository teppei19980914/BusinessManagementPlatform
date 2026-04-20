/**
 * テーマ色定義ファイル (PR #73 新規 / PR #75 Phase 1 で `src/config/` に集約):
 *
 *   「全テーマ × 全トークン」の値を管理する唯一の真実 (single source of truth)。
 *   画面構築時 (HTML 組立時) にこの定義から CSS を生成して <style> に注入するため、
 *   `globals.css` には各テーマの色定義は置かない。
 *
 *   新しいトークンを追加する場合:
 *     1. `ThemeTokens` 型に key を追加 → TypeScript が 10 テーマ全てで値を要求する
 *        (追加漏れがコンパイルエラーで発覚する)
 *     2. shadcn の utility (`bg-X` / `text-X`) として使いたい場合は
 *        `globals.css` の `@theme inline` マッピングに `--color-X: var(--X);` を追記
 *
 *   新しいテーマを追加する場合:
 *     1. `src/config/themes.ts` の `THEMES` に ID と表示名を追加
 *     2. このファイルの `THEME_DEFINITIONS` にも同じ ID を追加
 *        → `satisfies Record<ThemeId, ThemeTokens>` 制約で両者の齟齬を型検査が検出
 *     3. テスト (`theme-definitions.test.ts`) が自動で「全テーマ全トークン」を検証
 */

import type { ThemeId } from './themes';

/**
 * 1 テーマが提供しなければならない CSS 変数の集合 (shadcn / Tailwind v4 互換)。
 *
 *   - 値は CSS 色関数 (oklch / rgb / hsl 等) をそのまま格納する文字列
 *   - camelCase で保持し、CSS 変数名は kebab-case (`--card-foreground` 等) に自動変換する
 *   - radius は数値差異に意味があるが「テーマごとに変える」類のものではないので
 *     ここには含めず `globals.css` の :root に残す (設計判断: §28.3 参照)
 */
export type ThemeTokens = {
  // サーフェス (背景)
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  // 基調色
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  // 構造
  border: string;
  input: string;
  ring: string;
  // データビジュアライズ (チャート 5 色)
  chart1: string;
  chart2: string;
  chart3: string;
  chart4: string;
  chart5: string;
  // サイドバー (現状未使用だが shadcn 互換で定義)
  sidebar: string;
  sidebarForeground: string;
  sidebarPrimary: string;
  sidebarPrimaryForeground: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  sidebarBorder: string;
  sidebarRing: string;
};

/**
 * ライトテーマ (既定値)。他テーマはこれを base にして差分上書きで表現すると
 * 保守性が上がるため、`extend` ヘルパで差分 spread するパターンを採用。
 */
const LIGHT: ThemeTokens = {
  background: 'oklch(1 0 0)',
  foreground: 'oklch(0.145 0 0)',
  card: 'oklch(1 0 0)',
  cardForeground: 'oklch(0.145 0 0)',
  popover: 'oklch(1 0 0)',
  popoverForeground: 'oklch(0.145 0 0)',
  primary: 'oklch(0.205 0 0)',
  primaryForeground: 'oklch(0.985 0 0)',
  secondary: 'oklch(0.97 0 0)',
  secondaryForeground: 'oklch(0.205 0 0)',
  muted: 'oklch(0.97 0 0)',
  mutedForeground: 'oklch(0.556 0 0)',
  accent: 'oklch(0.97 0 0)',
  accentForeground: 'oklch(0.205 0 0)',
  destructive: 'oklch(0.577 0.245 27.325)',
  border: 'oklch(0.922 0 0)',
  input: 'oklch(0.922 0 0)',
  ring: 'oklch(0.708 0 0)',
  chart1: 'oklch(0.87 0 0)',
  chart2: 'oklch(0.556 0 0)',
  chart3: 'oklch(0.439 0 0)',
  chart4: 'oklch(0.371 0 0)',
  chart5: 'oklch(0.269 0 0)',
  sidebar: 'oklch(0.985 0 0)',
  sidebarForeground: 'oklch(0.145 0 0)',
  sidebarPrimary: 'oklch(0.205 0 0)',
  sidebarPrimaryForeground: 'oklch(0.985 0 0)',
  sidebarAccent: 'oklch(0.97 0 0)',
  sidebarAccentForeground: 'oklch(0.205 0 0)',
  sidebarBorder: 'oklch(0.922 0 0)',
  sidebarRing: 'oklch(0.708 0 0)',
};

/** LIGHT から差分を上書きしたテーマを作るヘルパ (DRY 化 + 差分の見通し向上)。 */
function extend(diff: Partial<ThemeTokens>): ThemeTokens {
  return { ...LIGHT, ...diff };
}

/**
 * 全テーマの色トークン定義。`satisfies Record<ThemeId, ThemeTokens>` により
 * ThemeId に列挙されたすべての ID が、ThemeTokens の全フィールドを備えているか
 * をコンパイル時に型検査する (添加漏れ・キー欠落がビルドで発覚する)。
 */
export const THEME_DEFINITIONS = {
  light: LIGHT,

  dark: extend({
    background: 'oklch(0.145 0 0)',
    foreground: 'oklch(0.985 0 0)',
    card: 'oklch(0.205 0 0)',
    cardForeground: 'oklch(0.985 0 0)',
    popover: 'oklch(0.205 0 0)',
    popoverForeground: 'oklch(0.985 0 0)',
    primary: 'oklch(0.922 0 0)',
    primaryForeground: 'oklch(0.205 0 0)',
    secondary: 'oklch(0.269 0 0)',
    secondaryForeground: 'oklch(0.985 0 0)',
    muted: 'oklch(0.269 0 0)',
    mutedForeground: 'oklch(0.708 0 0)',
    accent: 'oklch(0.269 0 0)',
    accentForeground: 'oklch(0.985 0 0)',
    destructive: 'oklch(0.704 0.191 22.216)',
    border: 'oklch(1 0 0 / 10%)',
    input: 'oklch(1 0 0 / 15%)',
    ring: 'oklch(0.556 0 0)',
    sidebar: 'oklch(0.205 0 0)',
    sidebarForeground: 'oklch(0.985 0 0)',
    sidebarPrimary: 'oklch(0.488 0.243 264.376)',
    sidebarPrimaryForeground: 'oklch(0.985 0 0)',
    sidebarAccent: 'oklch(0.269 0 0)',
    sidebarAccentForeground: 'oklch(0.985 0 0)',
    sidebarBorder: 'oklch(1 0 0 / 10%)',
    sidebarRing: 'oklch(0.556 0 0)',
  }),

  // ---------- パステル系 (低彩度 chroma 0.02〜0.04) ----------
  'pastel-blue': extend({
    background: 'oklch(0.97 0.02 240)',
    primary: 'oklch(0.55 0.09 240)',
    primaryForeground: 'oklch(0.99 0 0)',
    secondary: 'oklch(0.93 0.03 240)',
    secondaryForeground: 'oklch(0.3 0.06 240)',
    accent: 'oklch(0.93 0.03 240)',
    accentForeground: 'oklch(0.3 0.06 240)',
    muted: 'oklch(0.95 0.02 240)',
    border: 'oklch(0.88 0.03 240)',
    input: 'oklch(0.9 0.03 240)',
    ring: 'oklch(0.7 0.08 240)',
  }),
  'pastel-green': extend({
    background: 'oklch(0.97 0.02 150)',
    primary: 'oklch(0.5 0.1 150)',
    primaryForeground: 'oklch(0.99 0 0)',
    secondary: 'oklch(0.93 0.03 150)',
    secondaryForeground: 'oklch(0.3 0.06 150)',
    accent: 'oklch(0.93 0.03 150)',
    accentForeground: 'oklch(0.3 0.06 150)',
    muted: 'oklch(0.95 0.02 150)',
    border: 'oklch(0.88 0.03 150)',
    input: 'oklch(0.9 0.03 150)',
    ring: 'oklch(0.7 0.08 150)',
  }),
  'pastel-yellow': extend({
    background: 'oklch(0.97 0.03 90)',
    primary: 'oklch(0.55 0.1 90)',
    primaryForeground: 'oklch(0.99 0 0)',
    secondary: 'oklch(0.93 0.04 90)',
    secondaryForeground: 'oklch(0.3 0.07 90)',
    accent: 'oklch(0.93 0.04 90)',
    accentForeground: 'oklch(0.3 0.07 90)',
    muted: 'oklch(0.95 0.03 90)',
    border: 'oklch(0.88 0.04 90)',
    input: 'oklch(0.9 0.04 90)',
    ring: 'oklch(0.7 0.09 90)',
  }),
  'pastel-red': extend({
    background: 'oklch(0.97 0.02 20)',
    primary: 'oklch(0.55 0.11 20)',
    primaryForeground: 'oklch(0.99 0 0)',
    secondary: 'oklch(0.93 0.03 20)',
    secondaryForeground: 'oklch(0.3 0.07 20)',
    accent: 'oklch(0.93 0.03 20)',
    accentForeground: 'oklch(0.3 0.07 20)',
    muted: 'oklch(0.95 0.02 20)',
    border: 'oklch(0.88 0.03 20)',
    input: 'oklch(0.9 0.03 20)',
    ring: 'oklch(0.7 0.09 20)',
  }),

  // ---------- ポップ系 (高彩度 chroma 0.06〜0.2) ----------
  'pop-blue': extend({
    background: 'oklch(0.95 0.06 240)',
    primary: 'oklch(0.45 0.18 240)',
    primaryForeground: 'oklch(0.99 0 0)',
    secondary: 'oklch(0.9 0.08 240)',
    secondaryForeground: 'oklch(0.25 0.15 240)',
    accent: 'oklch(0.9 0.08 240)',
    accentForeground: 'oklch(0.25 0.15 240)',
    muted: 'oklch(0.93 0.06 240)',
    border: 'oklch(0.82 0.1 240)',
    input: 'oklch(0.85 0.1 240)',
    ring: 'oklch(0.55 0.18 240)',
  }),
  'pop-green': extend({
    background: 'oklch(0.95 0.07 150)',
    primary: 'oklch(0.45 0.18 150)',
    primaryForeground: 'oklch(0.99 0 0)',
    secondary: 'oklch(0.9 0.09 150)',
    secondaryForeground: 'oklch(0.25 0.15 150)',
    accent: 'oklch(0.9 0.09 150)',
    accentForeground: 'oklch(0.25 0.15 150)',
    muted: 'oklch(0.93 0.07 150)',
    border: 'oklch(0.82 0.12 150)',
    input: 'oklch(0.85 0.12 150)',
    ring: 'oklch(0.55 0.18 150)',
  }),
  'pop-yellow': extend({
    background: 'oklch(0.95 0.1 90)',
    primary: 'oklch(0.5 0.18 90)',
    primaryForeground: 'oklch(0.99 0 0)',
    secondary: 'oklch(0.9 0.13 90)',
    secondaryForeground: 'oklch(0.3 0.15 90)',
    accent: 'oklch(0.9 0.13 90)',
    accentForeground: 'oklch(0.3 0.15 90)',
    muted: 'oklch(0.93 0.1 90)',
    border: 'oklch(0.82 0.15 90)',
    input: 'oklch(0.85 0.15 90)',
    ring: 'oklch(0.6 0.18 90)',
  }),
  'pop-red': extend({
    background: 'oklch(0.95 0.07 20)',
    primary: 'oklch(0.5 0.2 20)',
    primaryForeground: 'oklch(0.99 0 0)',
    secondary: 'oklch(0.9 0.1 20)',
    secondaryForeground: 'oklch(0.28 0.16 20)',
    accent: 'oklch(0.9 0.1 20)',
    accentForeground: 'oklch(0.28 0.16 20)',
    muted: 'oklch(0.93 0.08 20)',
    border: 'oklch(0.82 0.12 20)',
    input: 'oklch(0.85 0.12 20)',
    ring: 'oklch(0.55 0.2 20)',
  }),
} as const satisfies Record<ThemeId, ThemeTokens>;
