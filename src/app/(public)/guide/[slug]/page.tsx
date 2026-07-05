/**
 * `/guide/[slug]` — 外部公開用ガイドの個別ページ (認証不要)。
 *
 * 真値: `docs/public/{slug}.md`。
 * CHANGELOG.md から機能名にリンクを埋め込んで参照する用途。
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChangelogEntryBody } from '../../changelog/changelog-entry-body';

interface PageProps {
  params: Promise<{ slug: string }>;
}

const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]*$/;
const DOCS_DIR = resolve(process.cwd(), 'docs/public');

function loadGuide(slug: string): { title: string; body: string } | null {
  if (!SAFE_SLUG.test(slug)) return null;

  const filePath = resolve(DOCS_DIR, `${slug}.md`);
  // Guard against path traversal (slug should never escape DOCS_DIR, but belt-and-suspenders)
  if (!filePath.startsWith(DOCS_DIR + '/') && !filePath.startsWith(DOCS_DIR + '\\')) return null;
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, 'utf-8');
  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1] : slug;
  return { title, body: raw };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const guide = loadGuide(slug);
  if (!guide) return { title: 'ガイドが見つかりません' };
  return {
    title: `${guide.title} | たすきば Knowledge Relay`,
  };
}

export default async function GuideDocPage({ params }: PageProps) {
  const { slug } = await params;
  const guide = loadGuide(slug);
  if (!guide) notFound();

  return (
    <article className="space-y-6">
      <Link href="/changelog" className="text-xs text-muted-foreground hover:underline">
        ← 更新履歴に戻る
      </Link>
      <div className="rounded-lg border border-border bg-card p-5">
        <ChangelogEntryBody body={guide.body} />
      </div>
    </article>
  );
}
