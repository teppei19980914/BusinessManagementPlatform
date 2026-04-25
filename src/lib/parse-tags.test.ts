import { describe, it, expect } from 'vitest';
import { parseTagsInput } from './parse-tags';

describe('parseTagsInput', () => {
  it('returns empty array for empty string', () => {
    expect(parseTagsInput('')).toEqual([]);
  });

  it('returns empty array for whitespace only', () => {
    expect(parseTagsInput('   ')).toEqual([]);
  });

  it('splits on half-width comma', () => {
    expect(parseTagsInput('React,Next.js,TypeScript')).toEqual([
      'React',
      'Next.js',
      'TypeScript',
    ]);
  });

  it('splits on half-width comma with spaces', () => {
    expect(parseTagsInput('React, Next.js, TypeScript')).toEqual([
      'React',
      'Next.js',
      'TypeScript',
    ]);
  });

  it('splits on Japanese ideographic comma (、)', () => {
    // 日本語入力中に自然に混ざるケース。以前はタグ 1 件扱いだった。
    expect(parseTagsInput('基幹、会計、業務フロー')).toEqual([
      '基幹',
      '会計',
      '業務フロー',
    ]);
  });

  it('splits on mixed comma types', () => {
    // 半角・全角が混在してもすべて区切りとして扱う
    expect(parseTagsInput('React、Next.js, TypeScript、PostgreSQL')).toEqual([
      'React',
      'Next.js',
      'TypeScript',
      'PostgreSQL',
    ]);
  });

  it('drops empty entries (trailing / consecutive separators)', () => {
    expect(parseTagsInput('React,,Next.js,')).toEqual(['React', 'Next.js']);
    expect(parseTagsInput('React、、Next.js、')).toEqual(['React', 'Next.js']);
  });

  it('trims surrounding whitespace of each tag', () => {
    expect(parseTagsInput('  React  ,  Next.js  ')).toEqual(['React', 'Next.js']);
  });

  it('does NOT split on semicolon (intentional: tags may contain ;)', () => {
    // タグ単語内に `;` / `/` 等が入るケース (例: バージョン表記) を誤分割しない
    expect(parseTagsInput('React 18;Next.js 16')).toEqual(['React 18;Next.js 16']);
  });

  it('does NOT split on slash (intentional)', () => {
    expect(parseTagsInput('React 18.3/Next 16')).toEqual(['React 18.3/Next 16']);
  });

  it('does NOT split on newline (intentional, tags are single-line)', () => {
    expect(parseTagsInput('React\nNext.js')).toEqual(['React\nNext.js']);
  });
});
