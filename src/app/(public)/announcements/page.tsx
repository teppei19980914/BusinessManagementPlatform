/**
 * `/announcements` — お知らせ一覧 (feat/app-version-changelog-footer / 2026-05-23)。
 *
 * 真値: `docs/public/announcements/*.md` (frontmatter 駆動)。
 * 認証不要。サービスからの告知 (新機能・障害情報・メンテナンス) を時系列で表示する。
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { loadAnnouncementMetas, type AnnouncementSeverity } from '@/lib/announcements';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('announcementsPage');
  return {
    title: `${t('pageTitle')} | たすきば Knowledge Relay`,
    description: t('pageDescription'),
  };
}

/** severity から表示用バッジクラスを引く. tailwind が PurgeCSS で消さないよう全クラスを直書き. */
function severityBadgeClasses(severity: AnnouncementSeverity): string {
  switch (severity) {
    case 'critical':
      return 'border-destructive/40 bg-destructive/10 text-destructive';
    case 'warning':
      return 'border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100';
    case 'maintenance':
      return 'border-sky-400 bg-sky-50 text-sky-900 dark:bg-sky-900/30 dark:text-sky-100';
    case 'info':
    default:
      return 'border-border bg-muted text-foreground';
  }
}

export default async function AnnouncementsPage() {
  const t = await getTranslations('announcementsPage');
  const announcements = loadAnnouncementMetas();

  const severityLabel: Record<AnnouncementSeverity, string> = {
    info: t('categoryInfo'),
    warning: t('categoryWarning'),
    critical: t('categoryCritical'),
    maintenance: t('categoryMaintenance'),
  };

  return (
    <article className="space-y-6" data-testid="announcements-page">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">{t('pageTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </header>

      {announcements.length === 0 ? (
        <p className="rounded border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {t('noEntries')}
        </p>
      ) : (
        <ul className="space-y-4">
          {announcements.map((a) => (
            <li
              key={a.slug}
              className="space-y-2 rounded-lg border border-border bg-card p-5"
              data-testid={`announcement-${a.slug}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">
                  <Link
                    href={`/announcements/${a.slug}`}
                    className="hover:underline"
                  >
                    {a.title}
                  </Link>
                </h2>
                <div className="flex items-center gap-2 text-xs">
                  <span
                    className={`rounded border px-2 py-0.5 ${severityBadgeClasses(a.severity)}`}
                  >
                    {severityLabel[a.severity]}
                  </span>
                  <time className="text-muted-foreground" dateTime={a.publishedAt}>
                    {a.publishedAt}
                  </time>
                </div>
              </div>
              {a.summary && (
                <p className="text-sm text-muted-foreground">{a.summary}</p>
              )}
              <Link
                href={`/announcements/${a.slug}`}
                className="text-xs text-primary hover:underline"
              >
                {t('readMore')} →
              </Link>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
