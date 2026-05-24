/**
 * `/announcements/[slug]` — お知らせ詳細 (feat/app-version-changelog-footer / 2026-05-23)。
 *
 * 真値: `docs/public/announcements/{slug}.md` の frontmatter + 本文。
 * 認証不要。
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  getAnnouncement,
  loadAnnouncementMetas,
  type AnnouncementSeverity,
} from '@/lib/announcements';
import { ChangelogEntryBody } from '../../changelog/changelog-entry-body';

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return loadAnnouncementMetas().map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const a = getAnnouncement(slug);
  if (!a) {
    return { title: 'お知らせが見つかりません' };
  }
  return {
    title: `${a.title} | たすきば Knowledge Relay`,
    description: a.summary || a.title,
  };
}

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

export default async function AnnouncementDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const announcement = getAnnouncement(slug);
  if (!announcement) {
    notFound();
  }
  const t = await getTranslations('announcementsPage');

  const severityLabel: Record<AnnouncementSeverity, string> = {
    info: t('categoryInfo'),
    warning: t('categoryWarning'),
    critical: t('categoryCritical'),
    maintenance: t('categoryMaintenance'),
  };

  return (
    <article
      className="space-y-6"
      data-testid={`announcement-detail-${announcement.slug}`}
    >
      <header className="space-y-3">
        <Link
          href="/announcements"
          className="text-xs text-muted-foreground hover:underline"
        >
          ← {t('backToList')}
        </Link>
        <h1 className="text-2xl font-bold">{announcement.title}</h1>
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`rounded border px-2 py-0.5 ${severityBadgeClasses(announcement.severity)}`}
          >
            {severityLabel[announcement.severity]}
          </span>
          <time className="text-muted-foreground" dateTime={announcement.publishedAt}>
            {t('publishedAt')}: {announcement.publishedAt}
          </time>
        </div>
      </header>
      <div className="rounded-lg border border-border bg-card p-5">
        <ChangelogEntryBody body={announcement.body} />
      </div>
    </article>
  );
}
