'use client';

/**
 * チャット意味検索の結果カード (1 件分)。
 * 種別バッジ + タイトル + snippet + score + 詳細ページへのリンク。
 *
 * URL 生成は [src/lib/chat-search-link.ts] に集約。詳細ページが存在しない資産は
 * 「全○○」画面の useAutoOpenDialog 経由でダイアログ表示される設計。
 *
 * PR fix/chat-search-and-auto-open (2026-05-24):
 *   - C-3: onClick prop で親に navigation 開始を通知 (useTransition で wrap される)
 *   - C-4: disabled prop で session 読み込み中の memo カード操作を抑止
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
  disabled = false,
}: {
  hit: ChatSearchHit;
  /** ログイン中ユーザの id。memo の自分/他人 判定で /memos vs /all-memos を切替える。 */
  viewerUserId?: string | null;
  /** クリック時の通知 (親で useTransition による navigation pending 表示等に使う)。 */
  onClick?: () => void;
  /**
   * カードを操作不可にする (PR fix/chat-search-and-auto-open / C-4)。
   * session 読み込み中の memo カード等、誤遷移リスクのあるケースで親から true を渡す。
   */
  disabled?: boolean;
}) {
  const meta = KIND_META[hit.kind];
  const href = buildChatHitLink(hit, { viewerUserId });

  // disabled 時は Link ではなく div でレンダリングして遷移自体を不可能にする。
  // opacity / cursor で視覚的にも操作不可と分かるようにする。
  if (disabled) {
    return (
      <div
        aria-disabled="true"
        title="ユーザ情報を読み込み中です。少し待ってから再度お試しください"
        className={cn(
          'block rounded-md border border-border bg-background p-3 text-sm',
          'opacity-60 cursor-wait',
        )}
      >
        <CardInner meta={meta} hit={hit} />
      </div>
    );
  }

  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        'block rounded-md border border-border bg-background p-3 text-sm transition-colors',
        'hover:border-primary hover:bg-muted',
      )}
    >
      <CardInner meta={meta} hit={hit} />
    </Link>
  );
}

function CardInner({
  meta,
  hit,
}: {
  meta: { icon: string; label: string };
  hit: ChatSearchHit;
}) {
  return (
    <>
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
    </>
  );
}
