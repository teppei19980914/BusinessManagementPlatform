/**
 * テーマ定義 → CSS 文字列への変換 (PR #73):
 *
 *   `THEME_DEFINITIONS` オブジェクトから、各テーマに対応する
 *   `[data-theme="..."] { --xxx: ...; }` 形式の CSS を文字列生成する。
 *
 *   HTML 組立時 (Root Layout) に <style> タグに埋め込んで使う。
 *
 *   ※ この関数は純粋関数 (入力固定 → 出力固定)。DB / ネットワーク依存なし。
 *   ※ light テーマは `:root` セレクタと併記して「data-theme 未指定 / 不正値」時の
 *      既定テーマとして機能させる (SSR 未認証ページでも light が適用される)。
 */

import { THEME_DEFINITIONS, type ThemeTokens } from './definitions';

/** camelCase のキーを CSS カスタムプロパティ名 `--kebab-case` に変換する。 */
export function tokenToCssVarName(camel: string): string {
  // primaryForeground -> --primary-foreground / chart1 -> --chart-1
  const kebab = camel
    .replace(/([A-Z])/g, '-$1')
    .replace(/([a-z])(\d)/g, '$1-$2')
    .toLowerCase();
  return `--${kebab}`;
}

/** 1 テーマ分の { key: value } を `--key: value;` 行の並びに整形する (インデント 2 文字)。 */
function tokensToLines(tokens: ThemeTokens): string {
  return (Object.entries(tokens) as [keyof ThemeTokens, string][])
    .map(([k, v]) => `  ${tokenToCssVarName(k as string)}: ${v};`)
    .join('\n');
}

/**
 * 全テーマの CSS を一枚の文字列として生成する。
 * 出力例:
 *   :root, [data-theme="light"] { --background: ...; ... }
 *   [data-theme="dark"] { --background: ...; ... }
 *   [data-theme="pastel-blue"] { --background: ...; ... }
 *   ...
 */
export function generateThemeCss(): string {
  const blocks: string[] = [];
  for (const [id, tokens] of Object.entries(THEME_DEFINITIONS)) {
    // light テーマは :root にも同時適用 (data-theme 未指定時の既定として働く)
    const selector = id === 'light'
      ? ':root,\n[data-theme="light"]'
      : `[data-theme="${id}"]`;
    blocks.push(`${selector} {\n${tokensToLines(tokens as ThemeTokens)}\n}`);
  }
  return blocks.join('\n\n');
}
