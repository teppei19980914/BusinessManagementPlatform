/**
 * i18n 完全対応 (en-US 有効化 §11 T-06) のための抽出スクリプト。
 *
 * 目的:
 *   `src/app/` 配下の .tsx ファイルから日本語文字列をハードコードしている箇所を
 *   一覧化し、`src/i18n/messages/{ja,en-US}.json` への移行候補をリストアップする。
 *
 * 出力形式:
 *   ファイルパス:行:列  「日本語文字列」
 *
 * 使い方:
 *   pnpm tsx scripts/i18n-extract-hardcoded-ja.ts > docs/i18n-extraction.txt
 *
 * 設計判断:
 *   - **全文字列を抽出**: JSX の text node + 属性値 (label / placeholder / title 等) を網羅
 *   - **既知の例外を除外**: コメント (// or /\* \*\/) 内の日本語、import path の日本語ファイル名 (存在する場合)
 *   - **形態素解析せず単純な正規表現**: ひらがな/カタカナ/漢字/記号を含む文字列リテラルを検出
 *   - **キー命名は別作業**: 抽出後に翻訳者が `field.title` / `message.deleteConfirm` 等の
 *     階層キーを割り当てる (本スクリプトは抽出のみ)
 *
 * 制限事項:
 *   - 動的に組み立てられた文字列 (テンプレートリテラルの ${...} 内) は検出するが
 *     翻訳キー化には人手判断が必要 (例: `${count} 件` は plural 対応)
 *   - 多言語対応が不要な箇所 (ログメッセージ等) も含まれるため、抽出後にレビュー必須
 *
 * 関連: DEVELOPER_GUIDE §10.10 (i18n 翻訳作業の規約)、§11 T-06 / T-10
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const TARGET_DIRS = [
  path.join(ROOT, 'src', 'app'),
  path.join(ROOT, 'src', 'components'),
];

/** ひらがな (3041-3096) / カタカナ (30A1-30FA) / 漢字 (4E00-9FFF) のいずれかを含む文字列。 */
const JA_PATTERN = /[ぁ-ゖァ-ヺ一-鿿]/;

/** 文字列リテラル (シングル/ダブル) を検出する正規表現。バッククオートは別途扱う。 */
const STRING_LITERAL_SQ = /'((?:\\.|[^'\\])*)'/g;
const STRING_LITERAL_DQ = /"((?:\\.|[^"\\])*)"/g;

/** コメント行を除外するための正規表現 (簡易): 二重スラッシュから行末まで。ブロックコメントは別途。 */
function stripComments(line: string): string {
  return line.replace(/\/\/.*$/, '');
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name)) {
      yield full;
    }
  }
}

async function extractFromFile(file: string): Promise<Array<{ file: string; line: number; col: number; text: string }>> {
  const content = await fs.readFile(file, 'utf8');
  const results: Array<{ file: string; line: number; col: number; text: string }> = [];

  // ブロックコメントを先に削除
  const noBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = noBlockComments.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const stripped = stripComments(lines[i]);
    for (const re of [STRING_LITERAL_SQ, STRING_LITERAL_DQ]) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(stripped)) !== null) {
        const text = match[1];
        if (JA_PATTERN.test(text)) {
          results.push({
            file: path.relative(ROOT, file),
            line: i + 1,
            col: (match.index ?? 0) + 1,
            text,
          });
        }
      }
    }

    // JSX text node (タグ間のテキスト) も簡易抽出: > ... < に挟まれた日本語
    const jsxTextRegex = />([^<>{}]+)</g;
    let jsxMatch;
    while ((jsxMatch = jsxTextRegex.exec(stripped)) !== null) {
      const text = jsxMatch[1].trim();
      if (text && JA_PATTERN.test(text) && !text.includes('"') && !text.includes("'")) {
        results.push({
          file: path.relative(ROOT, file),
          line: i + 1,
          col: (jsxMatch.index ?? 0) + 1,
          text,
        });
      }
    }
  }

  return results;
}

async function main() {
  const allResults: Array<{ file: string; line: number; col: number; text: string }> = [];

  for (const dir of TARGET_DIRS) {
    for await (const file of walk(dir)) {
      const items = await extractFromFile(file);
      allResults.push(...items);
    }
  }

  // 出力: ファイル順 → 行順
  allResults.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    return a.col - b.col;
  });

  // ユニーク日本語文字列のサマリ (頻出ベスト 30)
  const freq = new Map<string, number>();
  for (const r of allResults) {
    freq.set(r.text, (freq.get(r.text) ?? 0) + 1);
  }
  const top = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);

  console.log('# i18n 抽出結果');
  console.log(`# 総ヒット数: ${allResults.length}`);
  console.log(`# ユニーク文字列数: ${freq.size}`);
  console.log(`# 対象ファイル: ${TARGET_DIRS.map((d) => path.relative(ROOT, d)).join(', ')}`);
  console.log('');
  console.log('## 頻出文字列 (上位 30)');
  for (const [text, count] of top) {
    console.log(`  ${count.toString().padStart(4)}× ${text}`);
  }
  console.log('');
  console.log('## 全ヒット (ファイル:行:列  文字列)');
  for (const r of allResults) {
    console.log(`${r.file}:${r.line}:${r.col}\t${r.text}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
