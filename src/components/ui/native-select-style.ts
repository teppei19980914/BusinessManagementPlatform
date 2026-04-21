/**
 * ネイティブ `<select>` 要素共通のスタイル。
 *
 * 設計ポイント:
 * - 高さ `h-9` (36px) を確保し、`py-1.5` (3+3=6px 上下パディング) にすることで
 *   text-sm (14px) + 行高 (~18px) = 20px が切れずに表示される
 * - 旧 class は `h-8 py-2 flex items-center` だったが、`h-8` (32px) - `py-2` (16px)
 *   = 16px のコンテンツ領域しかなく 14px 文字+行高を確保できず、
 *   選択値の文字の下半分が見切れて「選択肢が見切れる」と誤認されていた
 * - `appearance: auto` をデフォルトに（意図せず `none` 化されないため明示は不要だが
 *   将来リセット CSS が入っても OS 既定の ▼ アイコンを維持する）
 * - Tailwind の `flex items-center` は `<select>` には適用しない
 *   （ブラウザ既定のテキスト配置に任せる。flex は inline 配置を崩す挙動があるため）
 *
 * PR #78 追加:
 * - `[&>option]:bg-popover [&>option]:text-popover-foreground` で
 *   ドロップダウン内 <option> のコントラストを各テーマに沿わせる。
 *   これにより `color-scheme` のブラウザ差異 (Firefox / Safari の限定対応)
 *   があっても、ダーク背景に暗い文字でオプションが読めない事態を防ぐ。
 * - select 自体にも `text-foreground` を明示し、`bg-transparent` 継承時の
 *   コントラスト保証を強化。
 *
 * 使い方:
 *   import { nativeSelectClass } from '@/components/ui/native-select-style';
 *   <select className={nativeSelectClass} ... />
 */
export const nativeSelectClass
  = 'h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 [&>option]:bg-popover [&>option]:text-popover-foreground';
