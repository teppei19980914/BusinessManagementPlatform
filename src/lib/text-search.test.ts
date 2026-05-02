import { describe, it, expect } from 'vitest';
import { splitKeywordTokens, matchesAnyKeyword, splitPositiveNegativeTokens } from './text-search';

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

// PR fix/list-export-and-filter (2026-05-01): 否定条件 (`-` プレフィックス) のサポート
describe('splitPositiveNegativeTokens (negation 拡張)', () => {
  it('positive のみ', () => {
    expect(splitPositiveNegativeTokens('foo bar')).toEqual({ positive: ['foo', 'bar'], negative: [] });
  });

  it('negative のみ', () => {
    expect(splitPositiveNegativeTokens('-foo -bar')).toEqual({ positive: [], negative: ['foo', 'bar'] });
  });

  it('positive と negative の混在', () => {
    expect(splitPositiveNegativeTokens('重要 -完了')).toEqual({ positive: ['重要'], negative: ['完了'] });
  });

  it('`-` 単独トークンは無視 (空 negation を作らない)', () => {
    expect(splitPositiveNegativeTokens('foo - bar')).toEqual({ positive: ['foo', 'bar'], negative: [] });
  });

  it('小文字に正規化される', () => {
    expect(splitPositiveNegativeTokens('FOO -BAR')).toEqual({ positive: ['foo'], negative: ['bar'] });
  });
});

describe('matchesAnyKeyword (negation 拡張)', () => {
  it('negative-only: 含まないものを残す', () => {
    expect(matchesAnyKeyword('-完了', ['対応中のタスク'])).toBe(true);
    expect(matchesAnyKeyword('-完了', ['完了済タスク'])).toBe(false);
  });

  it('positive + negative: 両方の条件を満たすもののみ', () => {
    // 「重要」を含み「完了」を含まない
    expect(matchesAnyKeyword('重要 -完了', ['重要なタスク (対応中)'])).toBe(true);
    expect(matchesAnyKeyword('重要 -完了', ['重要なタスク (完了済)'])).toBe(false); // negative にヒットして除外
    expect(matchesAnyKeyword('重要 -完了', ['普通のタスク (対応中)'])).toBe(false); // positive にヒットしないので除外
  });

  it('複数 negative: いずれか含めば除外 (AND 否定)', () => {
    expect(matchesAnyKeyword('-foo -bar', ['hello world'])).toBe(true);
    expect(matchesAnyKeyword('-foo -bar', ['hello foo'])).toBe(false);
    expect(matchesAnyKeyword('-foo -bar', ['hello bar'])).toBe(false);
  });

  it('複数 positive + 複数 negative の組み合わせ', () => {
    // (重要 OR 緊急) AND NOT (完了 OR キャンセル)
    expect(matchesAnyKeyword('重要 緊急 -完了 -キャンセル', ['緊急対応'])).toBe(true);
    expect(matchesAnyKeyword('重要 緊急 -完了 -キャンセル', ['重要 完了'])).toBe(false);
    expect(matchesAnyKeyword('重要 緊急 -完了 -キャンセル', ['重要 キャンセル'])).toBe(false);
    expect(matchesAnyKeyword('重要 緊急 -完了 -キャンセル', ['普通'])).toBe(false);
  });

  it('null / undefined フィールドは空文字扱い (negation も同様)', () => {
    expect(matchesAnyKeyword('-foo', ['hello', null, undefined])).toBe(true);
    expect(matchesAnyKeyword('-foo', ['hello foo', null])).toBe(false);
  });
});
