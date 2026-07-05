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
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { buildChatHitLink, buildProjectChatHitLink } from '@/lib/chat-search-link';
import type { ChatSearchHit, ChatSearchKind } from '@/services/chat-search.service';
import type { ProjectChatSearchHit, ProjectChatSearchKind } from '@/services/project-chat-search.service';

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
  const t = useTranslations('chatPanel');
  // 種別ごとの表示メタ情報。仕様 §3.4 のバッジ識別と整合。
  const KIND_META: Record<ChatSearchKind, { icon: string; label: string }> = {
    project: { icon: '📄', label: t('kindProject') },
    knowledge: { icon: '📕', label: t('kindKnowledge') },
    risk: { icon: '⚠️', label: t('kindRisk') },
    issue: { icon: '⚠️', label: t('kindIssue') },
    retrospective: { icon: '📋', label: t('kindRetrospective') },
    memo: { icon: '📝', label: t('kindMemo') },
    // ADR-0021 (2026-05-26): 添付ファイル本体検索結果
    attachment: { icon: '📎', label: t('kindAttachment') },
  };
  const meta = KIND_META[hit.kind];
  const href = buildChatHitLink(hit, { viewerUserId });

  // disabled 時は Link ではなく div でレンダリングして遷移自体を不可能にする。
  // opacity / cursor で視覚的にも操作不可と分かるようにする。
  if (disabled) {
    return (
      <div
        aria-disabled="true"
        title={t('loadingUserInfo')}
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

/**
 * プロジェクトスコープ意味検索 (PJ内から探す) の結果カード。
 * GlobalChatSearchResultCard と同構造だが ProjectChatSearchHit を受け取り、
 * projectId を使ってアイデア系の遷移先 URL を構築する。
 */
export function ProjectChatSearchResultCard({
  hit,
  projectId,
  onClick,
}: {
  hit: ProjectChatSearchHit;
  projectId: string;
  onClick?: () => void;
}) {
  const t = useTranslations('chatPanel');
  const KIND_META: Record<ProjectChatSearchKind, { icon: string; label: string }> = {
    knowledge: { icon: '📕', label: t('kindKnowledge') },
    risk: { icon: '⚠️', label: t('kindRisk') },
    issue: { icon: '⚠️', label: t('kindIssue') },
    retrospective: { icon: '📋', label: t('kindRetrospective') },
    qa_thread: { icon: '🙋', label: t('kindQaThread') },
    whiteboard_session: { icon: '🤔', label: t('kindWhiteboardSession') },
    voting_session: { icon: '🗳️', label: t('kindVotingSession') },
  };
  const meta = KIND_META[hit.kind];
  const href = buildProjectChatHitLink(hit, projectId);

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
        <span className="ml-auto whitespace-nowrap">
          {t('similarityScore', { score: hit.score.toFixed(2) })}
        </span>
      </div>
      <div className="line-clamp-1 font-medium">{hit.title}</div>
      <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{hit.snippet}</div>
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
  const t = useTranslations('chatPanel');
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
        <span className="ml-auto whitespace-nowrap">{t('similarityScore', { score: hit.score.toFixed(2) })}</span>
      </div>
      <div className="line-clamp-1 font-medium">{hit.title}</div>
      <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{hit.snippet}</div>
    </>
  );
}
