'use client';

/**
 * useListSearchParams フック (PR #425 / 2026-05-22 / KDD §5.X+102 Phase 1-3)。
 *
 * 役割:
 *   一覧画面の検索条件 (keyword / status / その他のフィルタ select) を
 *   **URL クエリパラメータに同期** する共通フック。
 *
 *   - 「入力即フィルタ」UI を維持しつつ、絞り込み条件を URL に反映する
 *     (= リロード時 / URL 共有時に検索状態が復元される)
 *   - 各画面の page.tsx (Server Component) は URL searchParams を受け取り
 *     listX service の filter 引数 + 初期値 props に伝播
 *   - 本フックは client 側の state を **URL と双方向同期** する
 *
 * 設計判断:
 *   - debounce: keyword 入力は 300ms debounce で router.replace (= 入力中の連続 push 回避)
 *   - non-keyword: select 系 (status / typeFilter 等) は即時 push
 *   - history mode: replace (= ブラウザ戻るボタンで検索条件をたどらせない、UX 簡潔化)
 *   - 空値は URL から除外 (= `?keyword=` のような空 param を残さない)
 *
 * 使い方:
 *   const { keyword, setKeyword, filters, setFilter } = useListSearchParams({
 *     initialKeyword: 'foo',
 *     initialFilters: { status: 'active', type: '' },
 *   });
 *   <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} />
 *   <Select value={filters.status} onValueChange={(v) => setFilter('status', v)}>...</Select>
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

type FilterMap = Record<string, string>;

export type UseListSearchParamsOptions<F extends FilterMap = FilterMap> = {
  /** URL から復元した keyword の初期値 (= page.tsx 側で sp.keyword ?? '' を渡す) */
  initialKeyword?: string;
  /** URL から復元した select 系 filter の初期値 (= page.tsx 側で sp.status ?? '' 等を渡す) */
  initialFilters?: F;
  /** keyword の URL push を遅延させる ms (= 入力即時 client filter を妨げない) */
  keywordDebounceMs?: number;
};

export type UseListSearchParamsResult<F extends FilterMap = FilterMap> = {
  keyword: string;
  setKeyword: (v: string) => void;
  filters: F;
  setFilter: <K extends keyof F & string>(key: K, value: string) => void;
  /** すべての検索条件をクリア (= URL からも除去 + state も空に) */
  clearAll: () => void;
};

export function useListSearchParams<F extends FilterMap = FilterMap>(
  options: UseListSearchParamsOptions<F> = {},
): UseListSearchParamsResult<F> {
  const router = useRouter();
  const pathname = usePathname();
  const currentSearchParams = useSearchParams();
  const debounceMs = options.keywordDebounceMs ?? 300;

  const [keyword, setKeywordState] = useState<string>(options.initialKeyword ?? '');
  const [filters, setFiltersState] = useState<F>(
    (options.initialFilters ?? ({} as F)) as F,
  );

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // URL を更新する低レベル関数。空値は param から除外する。
  const pushToUrl = useCallback(
    (kw: string, fls: FilterMap) => {
      // 現在の URL の他 params を保持しつつ自分の管理対象 params のみ書き換える
      const next = new URLSearchParams(currentSearchParams.toString());
      // keyword
      if (kw) next.set('keyword', kw);
      else next.delete('keyword');
      // filters
      for (const [k, v] of Object.entries(fls)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      const queryString = next.toString();
      const url = queryString ? `${pathname}?${queryString}` : pathname;
      // replace で履歴を汚さない
      router.replace(url, { scroll: false });
    },
    [router, pathname, currentSearchParams],
  );

  const setKeyword = useCallback(
    (v: string) => {
      setKeywordState(v);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        pushToUrl(v, filters);
      }, debounceMs);
    },
    [pushToUrl, filters, debounceMs],
  );

  const setFilter = useCallback(
    <K extends keyof F & string>(key: K, value: string) => {
      setFiltersState((prev) => {
        const next = { ...prev, [key]: value } as F;
        // select は即時 push (debounce 不要)
        pushToUrl(keyword, next);
        return next;
      });
    },
    [pushToUrl, keyword],
  );

  const clearAll = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    setKeywordState('');
    const emptied = Object.keys(filters).reduce<FilterMap>((acc, k) => {
      acc[k] = '';
      return acc;
    }, {});
    setFiltersState(emptied as F);
    pushToUrl('', emptied);
  }, [filters, pushToUrl]);

  // cleanup: unmount 時に debounce timer を解放
  useEffect(
    () => () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    },
    [],
  );

  return { keyword, setKeyword, filters, setFilter, clearAll };
}
