/**
 * `/changelog` — バージョン更新履歴 (feat/app-version-changelog-footer / 2026-05-23)。
 *
 * 真値: repository root の CHANGELOG.md (Keep a Changelog 形式)。
 * Server Component で fs.readFileSync 経由で読み出し、バージョン別カードに整形。
 *
 * 認証不要 (PUBLIC_PATHS に `/changelog` を追加済)。サービスが健全に運営されている
 * ことを潜在ユーザ・既存ユーザ双方に示すための窓口として機能する。
 *
 * markdown 描画は MarkdownTextarea と同じ react-markdown + remark-gfm + remark-breaks
 * を使う (一貫性のため)。`'use client'` ボーダーを越えるため、ReactMarkdown 利用部分は
 * 子 Client Component に分離する。
 */

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { loadChangelog } from '@/lib/changelog';
import { ChangelogEntryBody } from './changelog-entry-body';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('changelogPage');
  return {
    title: `${t('pageTitle')} | たすきば Knowledge Relay`,
    description: t('pageDescription'),
  };
}

export default async function ChangelogPage() {
  const t = await getTranslations('changelogPage');
  const entries = loadChangelog();

  return (
    <article className="space-y-6" data-testid="changelog-page">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">{t('pageTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </header>

      {entries.length === 0 ? (
        <p className="rounded border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {t('noEntries')}
        </p>
      ) : (
        <ol className="space-y-8">
          {entries.map((entry) => (
            <li
              key={entry.version}
              className="space-y-3 rounded-lg border border-border bg-card p-5"
              data-testid={`changelog-entry-${entry.version}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-xl font-semibold">v{entry.version}</h2>
                {entry.date && (
                  <time className="text-sm text-muted-foreground" dateTime={entry.date}>
                    {entry.date}
                  </time>
                )}
              </div>
              <ChangelogEntryBody body={entry.body} />
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
