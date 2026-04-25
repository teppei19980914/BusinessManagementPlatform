/**
 * タグ入力文字列を string[] に正規化する共通ユーティリティ
 * (fix/project-create-customer-validation でプロジェクト作成 / ナレッジ作成の重複定義を集約)。
 *
 * 対応する区切り文字:
 *   - `,` (U+002C, 半角カンマ)
 *   - `、` (U+3001, 読点 / Japanese ideographic comma)
 *   - 前後の空白は自動 trim (`, ` / `,  ` / `  , ` いずれも OK)
 *
 * 追加した理由:
 *   `,` のみ対応だった旧実装では、日本語入力モードのまま「基幹、会計」のように読点で区切った
 *   ユーザ入力がタグ 1 件扱いになり、提案精度 (核心機能) に直結する。
 *   placeholder は半角カンマで案内しているが、日本語テキスト入力中に読点が混ざるのは自然な
 *   UX のため両方受容する方針にする。
 *
 * NOT 対応 (意図的):
 *   - `;` / `/` / 改行: 世の中のタグ入力 UI で分岐しがちだが、プロジェクトタグは短い単語を想定
 *     しており、これらが単語内に含まれる (例: `React 18.3/Next 16`) ケースを誤分割しないよう
 *     除外する。
 *
 * @param s 生の入力文字列 (例: "React, Next.js、TypeScript")
 * @returns 空白 trim 済み + 空要素除去済みの string[]
 */
export function parseTagsInput(s: string): string[] {
  return s
    .split(/[,、]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
