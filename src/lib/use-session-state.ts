'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * sessionStorage と同期する useState (PR #61)。
 *
 * 要件: フィルタ条件や折りたたみなどのユーザ設定をセッション内で保持する。
 * 同一タブで開いている間は状態が残り続け、新しいタブやセッション終了時にデフォルトへ戻る。
 *
 * 実装メモ:
 *   - **ハイドレーション安全** : 初回レンダーは必ず defaultValue を使い、mount 後に useEffect で
 *     sessionStorage を読んで state を更新する。SSR (server render) と最初の client render が
 *     必ず一致するため React 19 のハイドレーションミスマッチを起こさない。
 *   - JSON シリアライズ可能な型を前提 (Set は Array で扱う useSessionStringSet を利用)
 *   - パース失敗 / storage 無効時はデフォルト値にフォールバック
 */
export function useSessionState<T>(
  key: string,
  defaultValue: T | (() => T),
): [T, (v: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(defaultValue);

  // 初回 mount 後に sessionStorage から復元 (SSR 時は実行されない)。
  // これは外部ストア (sessionStorage) との一度きりの同期であり、cascading render は起きない。
  // react-hooks/set-state-in-effect ルールが警告するが、hydration-safe pattern の
  // 標準実装として許容する (React 公式も storage-hydration で同等のパターンを紹介)。
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw !== null) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setState(JSON.parse(raw) as T);
      }
    } catch {
      // パース失敗 / storage 無効時はデフォルト値継続
    }
  }, [key]);

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
 *
 * 返り値の Set は `arr` が同値の間は同一参照を保つ (useMemo 経由)。
 * これにより React.memo の親再描画時の不要な子再描画を抑制できる。
 * 内部は Array<string> として JSON 化される。
 */
export function useSessionStringSet(
  key: string,
  defaultValues: () => string[],
): [Set<string>, (updater: (prev: Set<string>) => Set<string>) => void] {
  const [arr, setArr] = useSessionState<string[]>(key, defaultValues);
  // Set は「配列 arr が変わったときだけ」再生成する。
  // これで下流の memo (TaskTreeNode など) が expandedTaskIds === 比較で
  // 親再描画時に不要な子再描画を発生させなくなる。
  const set = useMemo(() => new Set(arr), [arr]);
  const setFromSet = useCallback(
    (updater: (prev: Set<string>) => Set<string>) => {
      setArr((prevArr) => Array.from(updater(new Set(prevArr))));
    },
    [setArr],
  );
  return [set, setFromSet];
}
