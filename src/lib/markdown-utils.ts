/**
 * MarkdownTextarea で使うヘルパ関数群 (feat/markdown-textarea)。
 *
 * 役割:
 *   - 入力テキストが Markdown 構文を含むか判定 (含めば Markdown プレビュー、
 *     含まなければ whitespace 保持のプレーンテキスト表示)
 *   - 既存値と入力値の語単位 diff を計算 (差分ハイライト用)
 *
 * テスト容易性のため React に依存しない純粋関数として切り出す。
 */

import { diffWordsWithSpace, type Change } from 'diff';

/**
 * Markdown 構文を示唆する代表的なパターン。
 * 完全な Markdown パーサではなく、軽量なヒューリスティック。
 *   - 見出し (#), 箇条書き (-, *, +), 番号付きリスト (1.)
 *   - 強調 (**, __), インラインコード (`)
 *   - リンク [text](url), 画像 ![alt](src)
 *   - テーブル (|), 引用 (>), 水平線 (---)
 *   - コードブロック (```)
 *
 * 1 つでもマッチすれば Markdown とみなす。誤検知より見落としを優先 (= ゆるめに判定)。
 */
const MARKDOWN_PATTERNS: RegExp[] = [
  /^#{1,6}\s+/m, // 見出し
  /^[*\-+]\s+/m, // 箇条書き
  /^\d+\.\s+/m, // 番号付きリスト
  /\*\*[^*]+\*\*/, // 太字
  /__[^_]+__/, // 太字 (アンダースコア)
  /(?<!`)`[^`\n]+`(?!`)/, // インラインコード
  /\[[^\]]+\]\([^)]+\)/, // リンク
  /!\[[^\]]*\]\([^)]+\)/, // 画像
  /^\|.*\|/m, // テーブル行
  /^>\s+/m, // 引用
  /^[-*_]{3,}\s*$/m, // 水平線
  /```[\s\S]*?```/, // コードブロック
];

/**
 * 入力文字列が Markdown 構文を含むか判定する。
 * 1 つでもパターンにマッチすれば true。
 */
export function isMarkdown(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  return MARKDOWN_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * 既存値と新入力値の語単位 diff を計算する。
 * `diff` ライブラリの diffWordsWithSpace を使い、空白も保持しつつ語単位で比較。
 *
 * @returns Change の配列。各要素は `{ value: 文字列, added?: true, removed?: true }`。
 *          added=true は新側にのみ存在 (追加)、removed=true は旧側にのみ (削除)、
 *          どちらも未設定なら共通部分。
 */
export function computeWordDiff(before: string, after: string): Change[] {
  return diffWordsWithSpace(before ?? '', after ?? '');
}

/**
 * Change[] から「旧側に表示する側」の chunks を抽出する。
 *   - 共通部分はそのまま
 *   - 削除された部分はハイライト (added は除外)
 */
export function extractBeforeChunks(changes: Change[]): Change[] {
  return changes.filter((c) => !c.added);
}

/**
 * Change[] から「新側に表示する側」の chunks を抽出する。
 *   - 共通部分はそのまま
 *   - 追加された部分はハイライト (removed は除外)
 */
export function extractAfterChunks(changes: Change[]): Change[] {
  return changes.filter((c) => !c.removed);
}
