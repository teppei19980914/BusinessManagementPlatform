'use client';

/**
 * ToastProvider (2026-04-30): リクエスト成功/失敗を画面下部に色分けで通知する共通基盤。
 *
 * 用途:
 *   各 client / dialog の CRUD 呼び出し直後に `useToast().showSuccess(message)` /
 *   `showError(message)` を呼び、ユーザに DB 操作の成否を即座にフィードバックする。
 *
 * 仕様:
 *   - 緑帯 (success) / 赤帯 (error) の 2 種を viewport 下部固定で表示
 *   - 同時に複数表示可 (新しいものほど下/手前)
 *   - 既定で 4 秒経過後に自動ディスミス、× ボタンで手動ディスミスも可
 *   - useId で id を払い出して key に使う (列挙時の競合を防ぐ)
 *
 * 設計判断:
 *   - LoadingProvider と同じく Context で公開、`<ToastProvider>` を dashboard layout に
 *     mount する。ライブラリ (sonner / react-toastify) を新規追加しない (依存最小化)。
 *   - メッセージ文字列は呼出側で用意する (人間が理解できる文言を制御するため)。
 *
 * 関連: DEVELOPER_GUIDE §5.43 (リクエスト成功/失敗の toast 通知パターン)
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

type ToastKind = 'success' | 'error';

type Toast = {
  id: string;
  kind: ToastKind;
  message: string;
};

/**
 * Values for ICU MessageFormat placeholders. Matches next-intl `TranslationValues`
 * (string | number | Date). Booleans should be stringified at the call site.
 */
type ToastParams = Record<string, string | number | Date>;

type ToastContextType = {
  /**
   * @deprecated Use {@link ToastContextType.showSuccessKey} with a catalog key.
   * Kept for incremental migration during the i18n zero-hardcode rollout.
   */
  showSuccess: (message: string) => void;
  /**
   * @deprecated Use {@link ToastContextType.showErrorKey} with a catalog key.
   */
  showError: (message: string) => void;
  /** Show a success toast by translating the given catalog key. */
  showSuccessKey: (key: string, params?: ToastParams) => void;
  /** Show an error toast by translating the given catalog key. */
  showErrorKey: (key: string, params?: ToastParams) => void;
};

const ToastContext = createContext<ToastContextType>({
  showSuccess: () => {},
  showError: () => {},
  showSuccessKey: () => {},
  showErrorKey: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

/** トーストの自動ディスミス時間 (ms)。短すぎると読めず、長すぎると邪魔。 */
const AUTO_DISMISS_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Capture root translator. ICU formatting + locale resolution happens at the
  // moment showSuccessKey/showErrorKey is called (= the caller's render context).
  const t = useTranslations();

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((kind: ToastKind, message: string) => {
    // crypto.randomUUID で id を払い出す。古いブラウザ向けのフォールバック付き。
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, kind, message }]);
  }, []);

  const showSuccess = useCallback(
    (message: string) => showToast('success', message),
    [showToast],
  );
  const showError = useCallback(
    (message: string) => showToast('error', message),
    [showToast],
  );
  const showSuccessKey = useCallback(
    (key: string, params?: ToastParams) => showToast('success', t(key, params)),
    [showToast, t],
  );
  const showErrorKey = useCallback(
    (key: string, params?: ToastParams) => showToast('error', t(key, params)),
    [showToast, t],
  );

  // Context value を useMemo で stable 化。これがないと toast 追加/消去で
  // ToastProvider が re-render する度に value object literal が新規生成され、
  // useToast() を消費する 25+ 箇所 (TaskTreeNode の memo を含む) が
  // 不要 re-render する。showSuccess/showError は useCallback で stable なので
  // value 全体も stable にできる。
  const value = useMemo(
    () => ({ showSuccess, showError, showSuccessKey, showErrorKey }),
    [showSuccess, showError, showSuccessKey, showErrorKey],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  const t = useTranslations('notification');
  if (toasts.length === 0) return null;
  return (
    <div
      role="region"
      aria-label={t('ariaLabel')}
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-stretch gap-2 px-4 py-4 sm:items-center"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  // ToastItem は描画後すぐに自動ディスミスタイマーを仕込む。
  // 親の toasts 配列が変化しても本トーストの id は不変なので effect は 1 回だけ走る。
  useEffect(() => {
    const handle = setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(handle);
  }, [toast.id, onDismiss]);

  const t = useTranslations('notification');
  const dismissLabelId = useId();

  return (
    <div
      className={cn(
        'pointer-events-auto flex items-start justify-between gap-3 rounded-md px-4 py-3 text-sm shadow-md',
        'sm:max-w-md',
        toast.kind === 'success'
          ? 'bg-success text-success-foreground'
          : 'bg-destructive text-destructive-foreground',
      )}
    >
      <span className="flex-1 break-words" id={dismissLabelId}>
        {toast.message}
      </span>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label={t('dismissAria')}
        aria-describedby={dismissLabelId}
        className="shrink-0 rounded p-0.5 opacity-80 transition-opacity hover:opacity-100"
      >
        ×
      </button>
    </div>
  );
}
