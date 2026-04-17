'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * 遅延フェッチの状態型。画面のローディング/エラー/ready を表現する。
 */
export type LazyState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: T };

export type LazyFetch<T> = {
  state: LazyState<T>;
  /** 未ロードなら取得開始。ready 済みなら no-op（force=true で強制再取得）*/
  load: (force?: boolean) => Promise<void>;
  /** ready 状態のデータを楽観的に上書きする（CRUD 直後の即時反映用）*/
  setData: (updater: (prev: T | null) => T) => void;
};

/**
 * タブ切替時にフェッチを開始し、結果をメモリキャッシュする汎用フック。
 *
 * - 並行呼び出しは 1 回に集約（最初の Promise を共有）
 * - fetch が失敗しても UI を落とさず error 状態を返す
 * - サーバは `{ data: T }` 形式の JSON を返すことを想定（プロジェクト API 共通）
 *
 * ref: docs/performance/20260417/after/cold-start-and-data-growth-analysis.md §4.2
 */
export function useLazyFetch<T>(url: string): LazyFetch<T> {
  const [state, setState] = useState<LazyState<T>>({ status: 'idle' });
  const inflightRef = useRef<Promise<void> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const load = useCallback(
    async (force = false) => {
      // ready 済みかつ force 未指定なら no-op（キャッシュヒット）
      if (!force && stateRef.current.status === 'ready') return;
      // 同時並行呼び出しは 1 本に集約
      if (inflightRef.current) return inflightRef.current;

      const promise = (async () => {
        setState({ status: 'loading' });
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json();
          setState({ status: 'ready', data: json.data });
        } catch (e) {
          setState({
            status: 'error',
            error: e instanceof Error ? e.message : 'unknown error',
          });
        } finally {
          inflightRef.current = null;
        }
      })();

      inflightRef.current = promise;
      return promise;
    },
    [url],
  );

  const setData = useCallback((updater: (prev: T | null) => T) => {
    setState((prev) => ({
      status: 'ready',
      data: updater(prev.status === 'ready' ? prev.data : null),
    }));
  }, []);

  return { state, load, setData };
}
