import { describe, it, expect } from 'vitest';
import {
  isMarkdown,
  computeWordDiff,
  extractBeforeChunks,
  extractAfterChunks,
} from './markdown-utils';

describe('isMarkdown', () => {
  it('空文字 / null 相当 / 空白のみは false', () => {
    expect(isMarkdown('')).toBe(false);
    expect(isMarkdown('   ')).toBe(false);
    expect(isMarkdown('\n\n')).toBe(false);
  });

  it('プレーンテキストは false', () => {
    expect(isMarkdown('普通の説明文です。')).toBe(false);
    expect(isMarkdown('複数行の\n説明文です。\n3 行目。')).toBe(false);
  });

  it('見出し (# ~ ######) を検出', () => {
    expect(isMarkdown('# 見出し')).toBe(true);
    expect(isMarkdown('## サブ見出し')).toBe(true);
    expect(isMarkdown('### 第3レベル')).toBe(true);
  });

  it('箇条書きを検出', () => {
    expect(isMarkdown('- 項目1\n- 項目2')).toBe(true);
    expect(isMarkdown('* 項目1')).toBe(true);
    expect(isMarkdown('+ 項目1')).toBe(true);
  });

  it('番号付きリストを検出', () => {
    expect(isMarkdown('1. 項目1\n2. 項目2')).toBe(true);
  });

  it('強調・コードを検出', () => {
    expect(isMarkdown('これは **太字** です')).toBe(true);
    expect(isMarkdown('__太字__')).toBe(true);
    expect(isMarkdown('インライン `code` 表示')).toBe(true);
  });

  it('リンク・画像を検出', () => {
    expect(isMarkdown('[リンク](https://example.com)')).toBe(true);
    expect(isMarkdown('![画像](https://example.com/img.png)')).toBe(true);
  });

  it('テーブル・引用・水平線を検出', () => {
    expect(isMarkdown('| 列1 | 列2 |\n|-----|-----|')).toBe(true);
    expect(isMarkdown('> 引用文')).toBe(true);
    expect(isMarkdown('---')).toBe(true);
  });

  it('コードブロックを検出', () => {
    expect(isMarkdown('```ts\nconst x = 1;\n```')).toBe(true);
  });

  it('数字とドットの組み合わせだけで誤検知しない (要 半角空白)', () => {
    // "1.5" のような小数表記は箇条書きにはマッチしない (パターンが `\d+\.\s+`)
    expect(isMarkdown('価格は 1.5 倍です')).toBe(false);
  });

  it('単体のバッククオートで誤検知しない', () => {
    // インラインコードはペアが必要
    expect(isMarkdown('シングル ` クオート')).toBe(false);
  });
});

describe('computeWordDiff', () => {
  it('完全一致なら added/removed なし', () => {
    const result = computeWordDiff('hello world', 'hello world');
    expect(result.every((c) => !c.added && !c.removed)).toBe(true);
  });

  it('追加のみは added チャンクが現れる', () => {
    const result = computeWordDiff('hello', 'hello world');
    expect(result.some((c) => c.added)).toBe(true);
    expect(result.some((c) => c.removed)).toBe(false);
  });

  it('削除のみは removed チャンクが現れる', () => {
    const result = computeWordDiff('hello world', 'hello');
    expect(result.some((c) => c.removed)).toBe(true);
    expect(result.some((c) => c.added)).toBe(false);
  });

  it('置換は removed + added の両方が現れる', () => {
    const result = computeWordDiff('hello world', 'hello universe');
    expect(result.some((c) => c.removed)).toBe(true);
    expect(result.some((c) => c.added)).toBe(true);
  });

  it('null/undefined 相当 (空文字) も安全に扱える', () => {
    expect(() => computeWordDiff('', 'hello')).not.toThrow();
    expect(() => computeWordDiff('hello', '')).not.toThrow();
  });
});

describe('extractBeforeChunks / extractAfterChunks', () => {
  it('before chunks は added を含まず、after chunks は removed を含まない', () => {
    const changes = computeWordDiff('apple banana', 'apple cherry');
    const before = extractBeforeChunks(changes);
    const after = extractAfterChunks(changes);

    expect(before.every((c) => !c.added)).toBe(true);
    expect(after.every((c) => !c.removed)).toBe(true);
  });

  it('完全一致なら before === after の中身 (共通部分のみ)', () => {
    const changes = computeWordDiff('hello world', 'hello world');
    const before = extractBeforeChunks(changes);
    const after = extractAfterChunks(changes);

    const beforeText = before.map((c) => c.value).join('');
    const afterText = after.map((c) => c.value).join('');
    expect(beforeText).toBe('hello world');
    expect(afterText).toBe('hello world');
  });
});
