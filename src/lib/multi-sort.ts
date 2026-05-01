/**
 * 複数列ソート (PR feat/sortable-columns / 2026-05-01)。
 *
 * 仕様 (Q4-1〜Q4-5 で確定):
 *   - SortState は配列 (順序 = 優先度、index 0 が最優先)
 *   - applySort: 既存 column を再設定 → in-place で direction 更新 (優先度維持)
 *               新 column を追加 → 末尾に追加 (低優先度)
 *               'clear' → 配列から除外
 *   - multiSort: state が空なら入力 items の順序を維持 (Q4-4 既存 orderBy を保つ)
 *   - 比較規則:
 *     - null / undefined / 空文字 を最後に並べる (asc / desc とも)
 *     - number は数値比較
 *     - Date は時刻比較
 *     - それ以外 (string) は ja ロケールの自然ソート (`localeCompare numeric`)
 */

export type SortDir = 'asc' | 'desc';
export type SortEntry = { columnKey: string; direction: SortDir };
export type SortState = SortEntry[];

/** 列のソート方向を更新する (新規追加 / 方向変更 / クリア)。優先度は維持。 */
export function applySort(
  state: SortState,
  columnKey: string,
  dir: SortDir | 'clear',
): SortState {
  if (dir === 'clear') {
    return state.filter((s) => s.columnKey !== columnKey);
  }
  const idx = state.findIndex((s) => s.columnKey === columnKey);
  if (idx >= 0) {
    // 既存 → 方向のみ更新、優先度維持
    const next = [...state];
    next[idx] = { columnKey, direction: dir };
    return next;
  }
  // 新規 → 末尾追加 (低優先度、設定順番ルール / Q4-5)
  return [...state, { columnKey, direction: dir }];
}

/** 列の現状 (direction + 優先度) を取得する。`null` なら未設定。 */
export function getColumnSort(
  state: SortState,
  columnKey: string,
): { direction: SortDir; priority: number } | null {
  const idx = state.findIndex((s) => s.columnKey === columnKey);
  if (idx < 0) return null;
  return { direction: state[idx].direction, priority: idx + 1 };
}

/** 行から列値を抜き出す getter 関数の型。entity ごとに呼出側が定義する。 */
export type ValueGetter<T> = (row: T, columnKey: string) => unknown;

function isNil(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

/** 値の自然な比較 (asc 基準で a < b なら負、a > b なら正)。 */
export function compareValues(a: unknown, b: unknown): number {
  const aNil = isNil(a);
  const bNil = isNil(b);
  // null は常に末尾 (asc / desc どちらでも)。direction で反転されないように呼出側が逆転前に処理済の前提。
  if (aNil && bNil) return 0;
  if (aNil) return 1;
  if (bNil) return -1;

  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1;
  }

  // 文字列 (フォールバック含む)。日本語 + 数字混在を自然順に並べる。
  return String(a).localeCompare(String(b), 'ja', { numeric: true, sensitivity: 'base' });
}

/**
 * items を SortState 順 (優先度順) に並び替える。
 * state が空なら items 配列をそのまま返す (新規配列も作らない、参照同一性を保つ)。
 */
export function multiSort<T>(
  items: readonly T[],
  state: SortState,
  getValue: ValueGetter<T>,
): readonly T[] {
  if (state.length === 0) return items; // Q4-4: 既存 orderBy を保つ
  return [...items].sort((a, b) => {
    for (const { columnKey, direction } of state) {
      const va = getValue(a, columnKey);
      const vb = getValue(b, columnKey);
      // null は常に末尾 (direction に依存しない)
      const aNil = isNil(va);
      const bNil = isNil(vb);
      if (aNil && bNil) continue;
      if (aNil) return 1;
      if (bNil) return -1;
      const cmp = compareValues(va, vb);
      if (cmp !== 0) return direction === 'asc' ? cmp : -cmp;
    }
    return 0;
  });
}
