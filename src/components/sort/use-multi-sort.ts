'use client';

/**
 * useMultiSort フック (PR feat/sortable-columns / 2026-05-01)。
 *
 * 一覧画面の複数列ソート状態を管理し、sessionStorage に永続化する (Q4-3 採用)。
 *
 * - 初期値は sessionStorage から復元、無ければ空配列
 * - 状態変化時に sessionStorage に書き戻し (タブを閉じるまで保持)
 * - storageKey は呼出側が一覧ごとに固有値を渡す (例: `'sort:risks'`, `'sort:knowledge'`)
 *
 * Q4-3 で localStorage ではなく sessionStorage を選んだ理由:
 *   - タブまたぎ / リロードでは保持したいが、ブラウザ閉じれば初期化したい
 *   - ユーザ間でのソート好み共有を意図しない (個人セッション内の利便性)
 */

import { useCallback, useEffect, useState } from 'react';
import type { SortDir, SortState } from '@/lib/multi-sort';
import { applySort } from '@/lib/multi-sort';

export type UseMultiSortResult = {
  sortState: SortState;
  setSortColumn: (columnKey: string, dir: SortDir | 'clear') => void;
  resetSort: () => void;
};

function loadFromStorage(storageKey: string): SortState {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // 形状チェック: 配列かつ各要素が { columnKey, direction } 構造
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is { columnKey: string; direction: SortDir } =>
        typeof s === 'object'
        && s !== null
        && typeof (s as { columnKey?: unknown }).columnKey === 'string'
        && ((s as { direction?: unknown }).direction === 'asc'
          || (s as { direction?: unknown }).direction === 'desc'),
    );
  } catch {
    return [];
  }
}

function saveToStorage(storageKey: string, state: SortState): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    /* QuotaExceededError 等は silent (UX を阻害しない) */
  }
}

export function useMultiSort(storageKey: string): UseMultiSortResult {
  const [sortState, setSortState] = useState<SortState>(() => loadFromStorage(storageKey));

  // sortState 変化時に persistence
  useEffect(() => {
    saveToStorage(storageKey, sortState);
  }, [storageKey, sortState]);

  const setSortColumn = useCallback(
    (columnKey: string, dir: SortDir | 'clear') => {
      setSortState((prev) => applySort(prev, columnKey, dir));
    },
    [],
  );

  const resetSort = useCallback(() => setSortState([]), []);

  return { sortState, setSortColumn, resetSort };
}
