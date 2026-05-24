'use client';

/**
 * チャット意味検索の結果カード (1 件分)。
 * 種別バッジ + タイトル + snippet + score + 詳細ページへのリンク。
 *
 * URL 生成は [src/lib/chat-search-link.ts] に集約。詳細ページが存在しない資産は
 * 「全○○」画面の useAutoOpenDialog 経由でダイアログ表示される設計。
 */

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { buildChatHitLink } from '@/lib/chat-search-link';
import type { ChatSearchHit, ChatSearchKind } from '@/services/chat-search.service';

/**
 * 種別ごとの表示メタ情報。仕様 §3.4 のバッジ識別と整合。
 */
const KIND_META: Record<ChatSearchKind, { icon: string; label: string }> = {
  project: { icon: '📄', label: 'プロジェクト' },
  knowledge: { icon: '📕', label: 'ナレッジ' },
  risk: { icon: '⚠️', label: 'リスク' },
  issue: { icon: '⚠️', label: '課題' },
  retrospective: { icon: '📋', label: '振り返り' },
  memo: { icon: '📝', label: 'メモ' },
};

export function ChatSearchResultCard({
  hit,
  viewerUserId,
  onClick,
}: {
  hit: ChatSearchHit;
  /** ログイン中ユーザの id。memo の自分/他人 判定で /memos vs /all-memos を切替える。 */
  viewerUserId?: string | null;
  onClick?: () => void;
}) {
  const meta = KIND_META[hit.kind];
  const href = buildChatHitLink(hit, { viewerUserId });

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
