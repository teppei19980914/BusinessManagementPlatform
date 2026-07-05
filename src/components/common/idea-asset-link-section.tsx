'use client';

/**
 * IdeaAssetLinkSection (v1.5.0 アイデア出し機能):
 *
 *   Task / Risk / Issue / Knowledge / Retrospective の各資産詳細ダイアログで
 *   「この資産に関連するアイデア」を逆引き表示する読み取り専用セクション。
 *
 *   アイデア側 (IdeaVotingSession / IdeaWhiteboardSession / IdeaQaThread) から
 *   資産へのリンクは /api/projects/[projectId]/idea/links から逆引きする。
 *
 *   ・リンクの追加・削除はアイデアタブ側で行うため、このセクションは表示のみ。
 *   ・projectId が null/undefined の場合はセクション自体を描画しない
 *     (cross-list 画面から開かれた孤立データ等)。
 */

import { useEffect, useState } from 'react';

const SOURCE_TYPE_LABELS: Record<string, string> = {
  voting_session: '投票',
  whiteboard_session: 'ホワイトボード',
  qa_thread: 'Q&A',
};

type IdeaLinkSummary = {
  id: string;
  sourceType: string;
  sourceId: string;
  targetTitle: string | null;
};

type Props = {
  projectId: string | null | undefined;
  targetType: 'task' | 'risk' | 'issue' | 'knowledge' | 'retrospective';
  targetId: string;
};

export function IdeaAssetLinkSection({ projectId, targetType, targetId }: Props) {
  const [links, setLinks] = useState<IdeaLinkSummary[] | null>(null);

  useEffect(() => {
    if (!projectId) return;
    void fetch(`/api/projects/${projectId}/idea/links?targetType=${targetType}&targetId=${targetId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { data?: IdeaLinkSummary[] } | null) => setLinks(json?.data ?? []))
      .catch(() => setLinks([]));
  }, [projectId, targetType, targetId]);

  if (!projectId || links === null || links.length === 0) return null;

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">関連するアイデア ({links.length})</h3>
      <ul className="flex flex-wrap gap-2">
        {links.map((link) => (
          <li
            key={link.id}
            className="flex max-w-full items-center gap-1.5 overflow-hidden rounded-full border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs"
            title={link.targetTitle ?? undefined}
          >
            <span className="shrink-0 font-medium text-primary/70">
              {SOURCE_TYPE_LABELS[link.sourceType] ?? link.sourceType}
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {link.targetTitle ?? link.sourceId.slice(0, 8)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
