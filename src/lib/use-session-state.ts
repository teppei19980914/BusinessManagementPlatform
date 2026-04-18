'use client';

import { useCallback, useState } from 'react';

/**
 * sessionStorage と同期する useState (PR #61)。
 *
 * 要件: フィルタ条件や折りたたみなどのユーザ設定をセッション内で保持する。
 * 同一タブで開いている間は状態が残り続け、新しいタブやセッション終了時にデフォルトへ戻る。
 *
 * 実装メモ:
 *   - SSR 時は defaultValue をそのまま使用 (sessionStorage はブラウザ API のみ)
 *   - クライアント初回レンダー時に sessionStorage を参照し、存在すれば復元
 *   - JSON シリアライズ可能な型を前提とする (Set は Array で扱う)
 *   - パース失敗時はデフォルト値にフォールバック (互換性破壊時の安全側動作)
 */
export function useSessionState<T>(
  key: string,
  defaultValue: T | (() => T),
): [T, (v: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(() => {
    const fallback = typeof defaultValue === 'function'
      ? (defaultValue as () => T)()
      : defaultValue;
    if (typeof window === 'undefined') return fallback;
    try {
      const raw = sessionStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch {
      // パース不能 / storage 無効時は defaultValue で継続
    }
    return fallback;
  });

  const setAndPersist = useCallback((v: T | ((prev: T) => T)) => {
    setState((prev) => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      try {
        if (typeof window !== 'undefined') {
          sessionStorage.setItem(key, JSON.stringify(next));
        }
      } catch {
        // quota 超過 / private mode 等は無視 (メモリ内状態のみ継続)
      }
      return next;
    });
  }, [key]);

  return [state, setAndPersist];
}

/**
 * Set<string> を sessionStorage 経由で保持するヘルパ。
 * 内部は Array<string> として JSON 化される。
 */
export function useSessionStringSet(
  key: string,
  defaultValues: () => string[],
): [Set<string>, (updater: (prev: Set<string>) => Set<string>) => void] {
  const [arr, setArr] = useSessionState<string[]>(key, defaultValues);
  const setFromSet = useCallback(
    (updater: (prev: Set<string>) => Set<string>) => {
      setArr((prevArr) => {
        const next = updater(new Set(prevArr));
        return Array.from(next);
      });
    },
    [setArr],
  );
  // new Set(...) をレンダー毎に生成することで参照比較依存のコードを誘発しないよう
  // 呼び出し側には Set を返しつつ、内部は配列で保持する。
  return [new Set(arr), setFromSet];
}
