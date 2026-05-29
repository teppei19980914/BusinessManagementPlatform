'use client';

import { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';

type LoadingContextType = {
  isLoading: boolean;
  startLoading: () => void;
  stopLoading: () => void;
  withLoading: <T>(fn: () => Promise<T>) => Promise<T>;
};

const LoadingContext = createContext<LoadingContextType>({
  isLoading: false,
  startLoading: () => {},
  stopLoading: () => {},
  withLoading: async (fn) => fn(),
});

export function useLoading() {
  return useContext(LoadingContext);
}

export function LoadingProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations('common');
  const [isLoading, setIsLoading] = useState(false);

  const startLoading = useCallback(() => setIsLoading(true), []);
  const stopLoading = useCallback(() => setIsLoading(false), []);

  const withLoading = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    setIsLoading(true);
    try {
      return await fn();
    } finally {
      setIsLoading(false);
    }
  }, []);

  // PR-1 perf (2026-05-29): value object を useMemo で安定化。
  //   未 memo だと毎レンダで新規参照になり、useLoading() を呼ぶ全 component が
  //   毎回再レンダされる (LoadingProvider は (dashboard)/layout 直下なので全画面に影響)。
  //   ToastProvider と同じ最適化パターン。
  const value = useMemo(
    () => ({ isLoading, startLoading, stopLoading, withLoading }),
    [isLoading, startLoading, stopLoading, withLoading],
  );

  return (
    <LoadingContext.Provider value={value}>
      {children}
      {isLoading && (
        // fix/loading-overlay-z (2026-05-26): z-50 → z-[60] に拡引き。
        //   旧 z-50 では Radix Dialog overlay (z-50) と同層になり、Portal で document.body
        //   末尾に rendering される Dialog の方が後勝ちで前面に出てしまい、ユーザが loading
        //   中に Dialog 内の Submit/Cancel ボタンを連打できる事故が起きていた。
        //   z-[60] にすることで Dialog (z-50) / Toast (z-50) / dropdown 各種 (z-50) より
        //   常に前面に表示し、loading 中の全 click を blur 越しにブロックする。
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/30 backdrop-blur-sm">
          <div className="flex items-center gap-3 rounded-lg bg-card px-6 py-4 shadow-lg">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground" />
            <span className="text-sm font-medium text-foreground">{t('loading')}</span>
          </div>
        </div>
      )}
    </LoadingContext.Provider>
  );
}
