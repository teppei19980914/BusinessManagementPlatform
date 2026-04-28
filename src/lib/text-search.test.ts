import { describe, it, expect } from 'vitest';
import { splitKeywordTokens, matchesAnyKeyword } from './text-search';

describe('splitKeywordTokens', () => {
  it('空文字列は空配列を返す', () => {
    expect(splitKeywordTokens('')).toEqual([]);
    expect(splitKeywordTokens('   ')).toEqual([]);
  });

  it('単一トークン (前後空白あり) を 1 要素配列で返す', () => {
    expect(splitKeywordTokens('  hello  ')).toEqual(['hello']);
  });

  it('半角空白で複数分割', () => {
    expect(splitKeywordTokens('foo bar baz')).toEqual(['foo', 'bar', 'baz']);
  });

  it('全角空白でも分割される (Phase C 要件 19: 日本語入力対応)', () => {
    expect(splitKeywordTokens('ログイン　エラー')).toEqual(['ログイン', 'エラー']);
  });

  it('連続空白は 1 つのデリミタ扱い', () => {
    expect(splitKeywordTokens('foo    bar')).toEqual(['foo', 'bar']);
  });

  it('大文字を小文字に正規化', () => {
    expect(splitKeywordTokens('Foo BAR')).toEqual(['foo', 'bar']);
  });
});

describe('matchesAnyKeyword', () => {
  it('query が空なら全件 true (フィルタ非適用)', () => {
    expect(matchesAnyKeyword('', ['hello'])).toBe(true);
    expect(matchesAnyKeyword('   ', ['hello'])).toBe(true);
  });

  it('単一トークンでフィールドのいずれかに含まれれば true', () => {
    expect(matchesAnyKeyword('foo', ['hello foo bar', 'baz'])).toBe(true);
    expect(matchesAnyKeyword('foo', ['hello bar', 'baz'])).toBe(false);
  });

  it('複数トークンは OR 条件 (1 つでもマッチすれば true)', () => {
    expect(matchesAnyKeyword('foo qux', ['hello bar', 'baz qux'])).toBe(true);
    expect(matchesAnyKeyword('foo qux', ['hello bar', 'baz'])).toBe(false);
  });

  it('null / undefined フィールドは空文字扱い', () => {
    expect(matchesAnyKeyword('foo', ['hello foo', null, undefined])).toBe(true);
    expect(matchesAnyKeyword('foo', [null, undefined])).toBe(false);
  });

  it('大小文字を区別しない', () => {
    expect(matchesAnyKeyword('FOO', ['Hello foo'])).toBe(true);
    expect(matchesAnyKeyword('foo', ['HELLO FOO'])).toBe(true);
  });

  it('全角空白でも OR 検索が成立 (Phase C 要件 19)', () => {
    expect(matchesAnyKeyword('ログイン　エラー', ['ログイン画面', 'normal'])).toBe(true);
    expect(matchesAnyKeyword('ログイン　エラー', ['認証エラー', 'normal'])).toBe(true);
    expect(matchesAnyKeyword('ログイン　エラー', ['通常動作', 'normal'])).toBe(false);
  });
});
