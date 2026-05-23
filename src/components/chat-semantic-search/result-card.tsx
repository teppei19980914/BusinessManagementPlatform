'use client';

/**
 * チャット意味検索の結果カード (1 件分)。
 * 種別バッジ + タイトル + snippet + score + 詳細ページへのリンク。
 */

import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { ChatSearchHit, ChatSearchKind } from '@/services/chat-search.service';

/**
 * 種別ごとの表示メタ情報。仕様 §3.4 のバッジ識別と整合。
 */
const KIND_META: Record<ChatSearchKind, { icon: string; label: string; hrefPrefix: string }> = {
  project: { icon: '📄', label: 'プロジェクト', hrefPrefix: '/projects' },
  knowledge: { icon: '📕', label: 'ナレッジ', hrefPrefix: '/knowledge' },
  risk: { icon: '⚠️', label: 'リスク', hrefPrefix: '/risks' },
  issue: { icon: '⚠️', label: '課題', hrefPrefix: '/issues' },
  retrospective: { icon: '📋', label: '振り返り', hrefPrefix: '/retrospectives' },
  memo: { icon: '📝', label: 'メモ', hrefPrefix: '/memos' },
};

export function ChatSearchResultCard({ hit, onClick }: { hit: ChatSearchHit; onClick?: () => void }) {
  const meta = KIND_META[hit.kind];
  const href = `${meta.hrefPrefix}/${hit.id}`;

  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        'block rounded-md border border-border bg-background p-3 text-sm transition-colors',
        'hover:border-primary hover:bg-muted',
      )}
    >
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium">
          {meta.icon} {meta.label}
        </span>
        {hit.sourceProjectName && (
          <span className="truncate" title={hit.sourceProjectName}>
            / {hit.sourceProjectName}
          </span>
        )}
        <span className="ml-auto whitespace-nowrap">類似度: {hit.score.toFixed(2)}</span>
      </div>
      <div className="line-clamp-1 font-medium">{hit.title}</div>
      <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{hit.snippet}</div>
    </Link>
  );
}
