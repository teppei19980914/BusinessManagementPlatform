'use client';

/**
 * NotificationBell (PR feat/notifications-mvp)
 *
 * DashboardHeader の右側 (アカウント名の左) に配置するベル UI。
 *
 * 仕様:
 *   - 未読 0 件 → ベルアイコンのみ。≥ 1 件 → 赤丸バッジに件数。
 *   - クリックでドロップダウン表示 (通知一覧、新しい順)。
 *   - 行クリック → 該当画面に遷移 + 既読化 (PATCH /api/notifications/[id])
 *   - 「すべて既読」 → 一括既読 (POST /api/notifications/mark-all-read)
 *   - 開いている間 30 秒、閉じている間 5 分 polling (バッテリー / コスト配慮)
 *
 * セキュリティ:
 *   - link は API 側で `/projects/<UUID>/tasks?taskId=<UUID>` 形式に固定 (path 構築は service 層、
 *     ユーザ入力混入なし)。`window.location.href` 代わりに `<Link>` で安全に遷移。
 *
 * 関連:
 *   - src/services/notification.service.ts
 *   - DashboardHeader (本コンポーネントを mount)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Bell } from 'lucide-react';
import { useToast } from '@/components/toast-provider';
import { formatDateTimeFull } from '@/lib/format';
import type { NotificationDTO } from '@/services/notification.service';

const POLL_INTERVAL_OPEN_MS = 30 * 1000; // 30 秒
const POLL_INTERVAL_CLOSED_MS = 5 * 60 * 1000; // 5 分

type FetchState =
  | { loaded: false }
  | { loaded: true; items: NotificationDTO[]; unreadCount: number };

export function NotificationBell() {
  const t = useTranslations('notification');
  const { showError } = useToast();
  const [state, setState] = useState<FetchState>({ loaded: false });
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications?includeRead=true&limit=20');
      if (!res.ok) {
        // failure は silent (一覧画面の継続性を阻害しない)。bell は最後に成功した状態を保持。
        return;
      }
      const json = await res.json();
      const data = json.data as { items: NotificationDTO[]; unreadCount: number };
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部 API (REST) 同期、AttachmentList と同パターン (DESIGN.md §22 例外規定)
      setState({ loaded: true, items: data.items ?? [], unreadCount: data.unreadCount ?? 0 });
    } catch {
      // network error も silent
    }
  }, []);

  // 初回 mount + open 状態変化で polling 間隔を切り替え
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reload() 内で setState、外部 API 同期の例外規定
    void reload();
    const interval = open ? POLL_INTERVAL_OPEN_MS : POLL_INTERVAL_CLOSED_MS;
    const timer = setInterval(() => void reload(), interval);
    return () => clearInterval(timer);
  }, [reload, open]);

  // 外側クリックでドロップダウンを閉じる
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const items = state.loaded ? state.items : [];
  const unreadCount = state.loaded ? state.unreadCount : 0;

  async function handleItemClick(n: NotificationDTO) {
    // 既読化を先に走らせる (画面遷移は <Link> で同時に発生)
    if (!n.readAt) {
      try {
        const res = await fetch(`/api/notifications/${n.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ read: true }),
        });
        if (!res.ok) {
          showError(t('markFailed'));
          return;
        }
      } catch {
        showError(t('markFailed'));
      }
    }
    setOpen(false);
    void reload();
  }

  async function handleMarkAllRead() {
    try {
      const res = await fetch('/api/notifications/mark-all-read', { method: 'POST' });
      if (!res.ok) {
        showError(t('markFailed'));
        return;
      }
      void reload();
    } catch {
      showError(t('markFailed'));
    }
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative flex items-center gap-1 rounded-md p-1.5 text-muted-foreground hover:bg-accent"
        aria-label={
          unreadCount > 0
            ? t('unreadBadge', { count: unreadCount })
            : t('ariaLabel')
        }
        data-testid="notification-bell"
      >
        <Bell className="size-5" />
        {unreadCount > 0 && (
          <span
            className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground"
            data-testid="notification-unread-count"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-md border bg-card shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-medium">{t('title')}</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => void handleMarkAllRead()}
                className="text-xs text-info hover:underline"
                data-testid="notification-mark-all-read"
              >
                {t('markAllAsRead')}
              </button>
            )}
          </div>

          <ul className="max-h-96 overflow-y-auto">
            {!state.loaded && (
              <li className="px-3 py-4 text-center text-xs text-muted-foreground">
                {t('loading')}
              </li>
            )}
            {state.loaded && items.length === 0 && (
              <li className="px-3 py-4 text-center text-xs text-muted-foreground">
                {t('empty')}
              </li>
            )}
            {items.map((n) => (
              <li
                key={n.id}
                className={`border-b last:border-b-0 ${n.readAt ? 'opacity-60' : 'bg-info/5'}`}
                data-testid="notification-item"
                data-read={n.readAt ? 'true' : 'false'}
              >
                <Link
                  href={n.link}
                  onClick={() => void handleItemClick(n)}
                  className="block px-3 py-2 hover:bg-accent"
                >
                  <p className="text-sm font-medium text-foreground">{n.title}</p>
                  <p className="text-[11px] text-muted-foreground" title={formatDateTimeFull(n.createdAt)}>
                    {formatDateTimeFull(n.createdAt)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
