import { describe, it, expect } from 'vitest';
import {
  applySort,
  compareValues,
  getColumnSort,
  multiSort,
  type SortState,
} from './multi-sort';

describe('applySort', () => {
  it('空 state に新規列を追加すると 1 件の配列になる', () => {
    const next = applySort([], 'title', 'asc');
    expect(next).toEqual([{ columnKey: 'title', direction: 'asc' }]);
  });

  it('既存 state に新規列を追加すると末尾に追加される (低優先度)', () => {
    const state: SortState = [{ columnKey: 'title', direction: 'asc' }];
    const next = applySort(state, 'createdAt', 'desc');
    expect(next).toEqual([
      { columnKey: 'title', direction: 'asc' },
      { columnKey: 'createdAt', direction: 'desc' },
    ]);
  });

  it('既存列の方向のみ変更しても優先度 (順序) は維持', () => {
    const state: SortState = [
      { columnKey: 'title', direction: 'asc' },
      { columnKey: 'createdAt', direction: 'desc' },
    ];
    const next = applySort(state, 'title', 'desc');
    expect(next).toEqual([
      { columnKey: 'title', direction: 'desc' },
      { columnKey: 'createdAt', direction: 'desc' },
    ]);
  });

  it('clear で対象列が除外される', () => {
    const state: SortState = [
      { columnKey: 'title', direction: 'asc' },
      { columnKey: 'createdAt', direction: 'desc' },
    ];
    const next = applySort(state, 'title', 'clear');
    expect(next).toEqual([{ columnKey: 'createdAt', direction: 'desc' }]);
  });

  it('clear で存在しない列を指定しても何も起きない', () => {
    const state: SortState = [{ columnKey: 'title', direction: 'asc' }];
    const next = applySort(state, 'nope', 'clear');
    expect(next).toEqual(state);
  });

  it('元の state を破壊しない (immutable)', () => {
    const state: SortState = [{ columnKey: 'title', direction: 'asc' }];
    applySort(state, 'createdAt', 'desc');
    expect(state).toEqual([{ columnKey: 'title', direction: 'asc' }]);
  });
});

describe('getColumnSort', () => {
  it('未設定の列は null を返す', () => {
    expect(getColumnSort([], 'title')).toBeNull();
    expect(getColumnSort([{ columnKey: 'a', direction: 'asc' }], 'b')).toBeNull();
  });

  it('設定済の列は direction + 1-based priority を返す', () => {
    const state: SortState = [
      { columnKey: 'a', direction: 'asc' },
      { columnKey: 'b', direction: 'desc' },
    ];
    expect(getColumnSort(state, 'a')).toEqual({ direction: 'asc', priority: 1 });
    expect(getColumnSort(state, 'b')).toEqual({ direction: 'desc', priority: 2 });
  });
});

describe('compareValues', () => {
  it('数値比較', () => {
    expect(compareValues(1, 2)).toBeLessThan(0);
    expect(compareValues(3, 2)).toBeGreaterThan(0);
    expect(compareValues(2, 2)).toBe(0);
  });

  it('Date 比較', () => {
    const d1 = new Date('2026-01-01');
    const d2 = new Date('2026-02-01');
    expect(compareValues(d1, d2)).toBeLessThan(0);
    expect(compareValues(d2, d1)).toBeGreaterThan(0);
  });

  it('boolean 比較 (false < true)', () => {
    expect(compareValues(false, true)).toBeLessThan(0);
    expect(compareValues(true, false)).toBeGreaterThan(0);
    expect(compareValues(true, true)).toBe(0);
  });

  it('null / undefined / 空文字 は常に末尾 (asc 基準で正の値を返す)', () => {
    expect(compareValues(null, 'x')).toBeGreaterThan(0);
    expect(compareValues(undefined, 'x')).toBeGreaterThan(0);
    expect(compareValues('', 'x')).toBeGreaterThan(0);
    expect(compareValues('x', null)).toBeLessThan(0);
    expect(compareValues(null, null)).toBe(0);
  });

  it('文字列の自然ソート (numeric: true)', () => {
    // 'foo2' < 'foo10' (numeric ソートでは 2 < 10)
    expect(compareValues('foo2', 'foo10')).toBeLessThan(0);
    expect(compareValues('foo10', 'foo2')).toBeGreaterThan(0);
  });

  it('日本語文字列の比較が落ちない', () => {
    expect(compareValues('あ', 'い')).toBeLessThan(0);
  });
});

describe('multiSort', () => {
  type Row = { id: string; title: string; priority: number | null };
  const rows: Row[] = [
    { id: 'a', title: 'apple', priority: 3 },
    { id: 'b', title: 'banana', priority: 1 },
    { id: 'c', title: 'apple', priority: 1 },
    { id: 'd', title: 'cherry', priority: null },
  ];
  const getValue = (r: Row, key: string): unknown =>
    key === 'title' ? r.title : key === 'priority' ? r.priority : null;

  it('state が空なら入力配列を返す (参照同一性)', () => {
    const result = multiSort(rows, [], getValue);
    expect(result).toBe(rows);
  });

  it('単一列 asc ソート', () => {
    const result = multiSort(rows, [{ columnKey: 'title', direction: 'asc' }], getValue);
    expect(result.map((r) => r.title)).toEqual(['apple', 'apple', 'banana', 'cherry']);
  });

  it('単一列 desc ソート', () => {
    const result = multiSort(rows, [{ columnKey: 'title', direction: 'desc' }], getValue);
    expect(result.map((r) => r.title)).toEqual(['cherry', 'banana', 'apple', 'apple']);
  });

  it('複数列ソート: title asc → priority desc (同 title 内で priority 降順)', () => {
    const result = multiSort(
      rows,
      [
        { columnKey: 'title', direction: 'asc' },
        { columnKey: 'priority', direction: 'desc' },
      ],
      getValue,
    );
    // apple-3, apple-1, banana-1, cherry-null
    expect(result.map((r) => r.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('null 値は direction に関わらず末尾', () => {
    // priority asc でも cherry (null) が末尾になる
    const ascResult = multiSort(rows, [{ columnKey: 'priority', direction: 'asc' }], getValue);
    expect(ascResult[ascResult.length - 1].id).toBe('d');
    // priority desc でも cherry (null) が末尾
    const descResult = multiSort(rows, [{ columnKey: 'priority', direction: 'desc' }], getValue);
    expect(descResult[descResult.length - 1].id).toBe('d');
  });

  it('元の配列を破壊しない', () => {
    const before = rows.map((r) => r.id);
    multiSort(rows, [{ columnKey: 'title', direction: 'desc' }], getValue);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});
