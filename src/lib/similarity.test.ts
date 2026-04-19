import { describe, it, expect } from 'vitest';
import { jaccard, unifyProjectTags, unifyKnowledgeTags, combineScores } from './similarity';

describe('jaccard', () => {
  it('完全一致は 1 を返す', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
  });

  it('重なりなしは 0 を返す', () => {
    expect(jaccard(['a'], ['b'])).toBe(0);
  });

  it('部分一致は交差 / 和集合', () => {
    // [a,b] ∩ [b,c] = {b}, ∪ = {a,b,c}, 1/3
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 5);
  });

  it('大文字小文字を無視する', () => {
    expect(jaccard(['React'], ['react'])).toBe(1);
  });

  it('前後の空白を無視する', () => {
    expect(jaccard([' React ', 'Next.js'], ['React', ' Next.js '])).toBe(1);
  });

  it('空配列同士は 0 を返す (提案対象から外すため)', () => {
    expect(jaccard([], [])).toBe(0);
  });

  it('片方が空なら 0', () => {
    expect(jaccard(['a'], [])).toBe(0);
    expect(jaccard([], ['a'])).toBe(0);
  });

  it('重複要素は 1 件として扱う (set 化)', () => {
    expect(jaccard(['a', 'a', 'b'], ['a', 'b'])).toBe(1);
  });

  it('空文字やホワイトスペースのみは除外される', () => {
    expect(jaccard(['a', '', '  '], ['a'])).toBe(1);
  });
});

describe('unifyProjectTags', () => {
  it('業務/技術/工程をそのまま連結して返す', () => {
    const tags = unifyProjectTags({
      businessDomainTags: ['金融'],
      techStackTags: ['React'],
      processTags: ['設計'],
    });
    expect(tags).toEqual(['金融', 'React', '設計']);
  });

  it('全て空でも空配列を返す', () => {
    expect(unifyProjectTags({ businessDomainTags: [], techStackTags: [], processTags: [] })).toEqual([]);
  });
});

describe('unifyKnowledgeTags', () => {
  it('tech + process + businessDomain を連結 (PR #65 Phase 2 (b))', () => {
    expect(
      unifyKnowledgeTags({
        techTags: ['React'],
        processTags: ['設計'],
        businessDomainTags: ['金融'],
      }),
    ).toEqual(['React', '設計', '金融']);
  });

  it('全て空でも空配列を返す', () => {
    expect(
      unifyKnowledgeTags({ techTags: [], processTags: [], businessDomainTags: [] }),
    ).toEqual([]);
  });
});

describe('combineScores', () => {
  it('重み付き平均を計算する', () => {
    expect(
      combineScores([
        { score: 0.8, weight: 0.5 },
        { score: 0.4, weight: 0.5 },
      ]),
    ).toBeCloseTo(0.6, 5);
  });

  it('重みが 0 のパートは無視する', () => {
    expect(
      combineScores([
        { score: 1.0, weight: 1 },
        { score: 0.0, weight: 0 },
      ]),
    ).toBeCloseTo(1, 5);
  });

  it('重み合計 0 なら 0 を返す', () => {
    expect(combineScores([{ score: 1, weight: 0 }])).toBe(0);
  });

  it('空配列は 0', () => {
    expect(combineScores([])).toBe(0);
  });
});
