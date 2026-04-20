/**
 * 画面テーマカタログ (PR #75 Phase 1 で src/types/index.ts から移動):
 *
 *   ユーザが設定画面で選択する全画面テーマの ID と表示名。
 *   実際の色定義 (CSS 変数値) は `theme-definitions.ts` 側で管理する。
 *
 *   ここは「テーマの存在」を定義する層、`theme-definitions.ts` は「各テーマの色値」を定義する層。
 *   2 つを分離することで、新しいテーマを追加するときに必要な更新箇所が明確になる
 *   (本ファイル + theme-definitions.ts の `THEME_DEFINITIONS` に同じ ID を追加)。
 */

export const THEMES = {
  light: 'ライトテーマ（デフォルト）',
  dark: 'ダークテーマ',
  'pastel-blue': 'パステル（青）',
  'pastel-green': 'パステル（緑）',
  'pastel-yellow': 'パステル（黄）',
  'pastel-red': 'パステル（赤）',
  'pop-blue': 'ポップ（青）',
  'pop-green': 'ポップ（緑）',
  'pop-yellow': 'ポップ（黄）',
  'pop-red': 'ポップ（赤）',
} as const;

export type ThemeId = keyof typeof THEMES;

/** 未知の文字列を安全にテーマ ID へ丸める (DB が将来値を持ちうるため)。 */
export function toSafeThemeId(value: string | null | undefined): ThemeId {
  if (value && value in THEMES) return value as ThemeId;
  return 'light';
}
