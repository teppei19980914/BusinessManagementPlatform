'use client';

/**
 * 最新お知らせバナー (feat/app-version-changelog-footer / 2026-05-23)。
 *
 * dashboard layout 上部に最新 1 件を表示する。Client Component で localStorage 経由の
 * dismiss を管理し、同じ slug を一度閉じたユーザには再表示しない。
 *
 * 表示判定:
 *   - props.announcement が null なら何も描画しない
 *   - localStorage `tasukiba-dismissed-announcement` に slug が記録されていれば非表示
 *   - severity=critical のみ強い色 (border-destructive)。それ以外は muted トーン
 *
 * SSR との整合 / lint rule への準拠:
 *   - `useSyncExternalStore` で localStorage を参照する (react-hooks/set-state-in-effect 警告回避)。
 *   - `getServerSnapshot` は null を返し、SSR 初回はバナー表示状態にする (= 非 dismiss)。
 *   - クライアントマウント直後に localStorage 値で再評価され、dismiss 済 slug なら非表示化。
 *   - dismiss ボタン押下時は `localDismissed` state を true に倒し、即時に消える (= storage 反映を待たない)。
 *
 * Severity 視覚:
 *   - critical: 強調 (border-destructive + bg-destructive/10)
 *   - warning: amber
 *   - maintenance: sky
 *   - info: muted
 */

import { useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import type { AnnouncementMeta, AnnouncementSeverity } from '@/lib/announcements';

const DISMISSED_STORAGE_KEY = 'tasukiba-dismissed-announcement';

/** storage 変更購読 (他タブからの dismiss も拾えるよう `storage` イベントに subscribe). */
function subscribeStorage(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('storage', callback);
  return () => window.removeEventListener('storage', callback);
}

function getDismissedSlugFromStorage(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** SSR 時は null を返す → 初回 render はバナー表示状態 (= 非 dismiss). */
function getServerSnapshot(): string | null {
  return null;
}

interface AnnouncementBannerProps {
  announcement: AnnouncementMeta | null;
}

function bannerClasses(severity: AnnouncementSeverity): string {
  switch (severity) {
    case 'critical':
      return 'border-destructive/40 bg-destructive/10';
    case 'warning':
      return 'border-amber-300 bg-amber-50 dark:bg-amber-900/30';
    case 'maintenance':
      return 'border-sky-300 bg-sky-50 dark:bg-sky-900/30';
    case 'info':
    default:
      return 'border-border bg-muted/50';
  }
}

export function AnnouncementBanner({ announcement }: AnnouncementBannerProps) {
  const t = useTranslations('announcementBanner');
  // localStorage に記録された dismiss 済 slug. SSR は null (バナー表示).
  const dismissedSlug = useSyncExternalStore(
    subscribeStorage,
    getDismissedSlugFromStorage,
    getServerSnapshot,
  );
  // 「今クリックして閉じた」を即時反映するためのローカル state. 永続化は localStorage 経由.
  const [locallyDismissed, setLocallyDismissed] = useState(false);

  if (!announcement) return null;
  const isDismissedFromStorage = dismissedSlug === announcement.slug;
  if (locallyDismissed || isDismissedFromStorage) return null;

  const handleDismiss = () => {
    setLocallyDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_STORAGE_KEY, announcement.slug);
    } catch {
      // 失敗してもバナーは閉じる (次回ロードで再表示するのは許容範囲)
    }
  };

  // CodeQL stored XSS 対策: 詳細ページの href 構築時に encodeURIComponent を明示適用。
  //   slug は loadAnnouncementMetas() で isSafeAnnouncementSlug() 通過済だが、CodeQL の
  //   taint 分析が boundary validation を追跡しないため sanitizer signal を出す。
  const detailHref = `/announcements/${encodeURIComponent(announcement.slug)}`;

  return (
    <div
      role="status"
      className={`border-b px-4 py-2 text-sm ${bannerClasses(announcement.severity)}`}
      data-testid="announcement-banner"
      data-slug={announcement.slug}
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs text-muted-foreground" data-testid="banner-date">
          {announcement.publishedAt}
        </span>
        <Link
          href={detailHref}
          className="flex-1 font-medium hover:underline"
          data-testid="banner-title"
        >
          {announcement.title}
        </Link>
        <Link
          href="/announcements"
          className="text-xs text-muted-foreground hover:underline"
        >
          {t('viewAll')}
        </Link>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={t('dismissAriaLabel')}
          className="rounded p-1 text-muted-foreground hover:bg-foreground/5"
          data-testid="banner-dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
