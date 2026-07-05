'use client';

/**
 * 匿名 Q&A タブ (v1.5.0)
 *
 * ソート: 投稿日時降順 (デフォルト) / いいね数 / 最終回答日時 / 未回答優先
 * フィルタ: 全て / オープン / クローズ / 未回答
 * stale バッジ: open かつ 14 日以上無回答
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/toast-provider';
import { useFormatters } from '@/lib/use-formatters';
import type { QaThreadDTO } from '@/services/idea-qa.service';

type Props = {
  projectId: string;
  canSubmit: boolean;
};

const SORT_LABELS: Record<string, string> = {
  createdAt: '投稿日時',
  upvoteCount: 'いいね数',
  lastAnsweredAt: '最終回答',
  unanswered: '未回答優先',
};

const FILTER_LABELS: Record<string, string> = {
  all: 'すべて',
  open: 'オープン',
  closed: '解消済み',
  unanswered: '未回答',
};

export function IdeaQaClient({ projectId, canSubmit }: Props) {
  const [threads, setThreads] = useState<QaThreadDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState('createdAt');
  const [filter, setFilter] = useState('all');
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [question, setQuestion] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { showSuccessKey, showErrorKey } = useToast();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setQ(searchInput), 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchInput]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ sort, filter });
      if (q) params.set('q', q);
      const res = await fetch(`/api/projects/${projectId}/idea/qa?${params}`);
      if (!res.ok) throw new Error();
      const { data } = await res.json();
      setThreads(data);
    } catch {
      showErrorKey('idea.toastFetchQaFailed');
    } finally {
      setLoading(false);
    }
  }, [projectId, sort, filter, q, showErrorKey]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  const handlePost = async () => {
    if (!question.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/idea/qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      if (!res.ok) {
        const body = await res.json();
        showErrorKey(body.error?.code === 'FORBIDDEN' ? 'idea.toastForbiddenCreate' : 'idea.toastQaPostFailed');
        return;
      }
      setQuestion('');
      showSuccessKey('idea.toastQaPosted');
      load();
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpvote = async (threadId: string) => {
    const res = await fetch(`/api/projects/${projectId}/idea/qa/${threadId}/upvote`, {
      method: 'POST',
    });
    if (!res.ok) return;
    load();
  };

  const handleClose = async (threadId: string) => {
    const res = await fetch(`/api/projects/${projectId}/idea/qa/${threadId}/close`, {
      method: 'POST',
    });
    if (!res.ok) {
      const body = await res.json();
      showErrorKey(body.error?.code === 'FORBIDDEN' ? 'idea.toastQaResolveOnlyPoster' : 'idea.toastQaResolveFailed');
      return;
    }
    showSuccessKey('idea.toastQaResolved');
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-semibold text-sm">匿名FAQ</h3>
        <div className="flex gap-2 text-sm flex-wrap">
          <input
            type="search"
            className="rounded border px-2 py-1 text-xs w-36"
            placeholder="キーワード検索..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <select
            className="rounded border px-2 py-1 text-xs"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            {Object.entries(SORT_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          <select
            className="rounded border px-2 py-1 text-xs"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            {Object.entries(FILTER_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
      </div>

      {/* 質問投稿フォーム */}
      {canSubmit && (
        <div className="flex gap-2">
          <textarea
            className="flex-1 rounded border px-3 py-1.5 text-sm resize-none"
            placeholder="匿名で質問を投稿..."
            rows={2}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <Button size="sm" onClick={handlePost} disabled={submitting || !question.trim()}>
            投稿
          </Button>
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">読み込み中...</div>
      ) : threads.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Q&A がありません</p>
      ) : (
        <div className="space-y-3">
          {threads.map((thread) => (
            <QaThreadCard
              key={thread.id}
              thread={thread}
              projectId={projectId}
              canSubmit={canSubmit}
              onUpvote={handleUpvote}
              onClose={handleClose}
              onReload={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function QaThreadCard({
  thread,
  projectId,
  canSubmit,
  onUpvote,
  onClose,
  onReload,
}: {
  thread: QaThreadDTO;
  projectId: string;
  canSubmit: boolean;
  onUpvote: (id: string) => void;
  onClose: (id: string) => void;
  onReload: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { showSuccessKey, showErrorKey } = useToast();
  const { formatDateTimeSeconds } = useFormatters();

  const handleAnswer = async () => {
    if (!answer.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/idea/qa/${thread.id}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: answer }),
      });
      if (!res.ok) {
        showErrorKey('idea.toastAnswerFailed');
        return;
      }
      setAnswer('');
      showSuccessKey('idea.toastAnswered');
      onReload();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-md border p-4 space-y-3">
      <div className="flex items-start gap-3">
        {/* いいね */}
        <button
          className={`flex flex-col items-center text-xs gap-0.5 ${thread.hasUpvoted ? 'text-primary' : 'text-muted-foreground'}`}
          onClick={() => canSubmit && onUpvote(thread.id)}
          disabled={!canSubmit}
        >
          <span className="text-base">❤</span>
          <span>{thread.upvoteCount}</span>
        </button>

        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium">{thread.question}</p>
            {thread.isStale && (
              <Badge variant="outline" className="text-xs text-orange-600 border-orange-400">
                長期未回答
              </Badge>
            )}
            <Badge variant={thread.status === 'open' ? 'default' : 'secondary'} className="text-xs">
              {thread.status === 'open' ? 'オープン' : '解消済み'}
            </Badge>
          </div>
          <div className="text-xs text-muted-foreground space-y-0.5">
            <p>
              作成: {formatDateTimeSeconds(thread.createdAt)}
              {thread.status === 'closed' && ` · 解消: ${formatDateTimeSeconds(thread.updatedAt)}`}
            </p>
            <p>
              回答: {thread.answerCount}件
              {thread.lastAnsweredAt && ` · 最終回答: ${formatDateTimeSeconds(thread.lastAnsweredAt)}`}
            </p>
          </div>
        </div>

        <div className="flex gap-1 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            className="text-xs"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? '閉じる' : `回答する/見る (${thread.answerCount})`}
          </Button>
          {thread.status === 'open' && canSubmit && (
            <Button
              size="sm"
              variant="outline"
              className="text-xs"
              onClick={() => onClose(thread.id)}
            >
              解消
            </Button>
          )}
        </div>
      </div>

      {/* 回答一覧 + 投稿フォーム */}
      {expanded && (
        <div className="pl-8 space-y-3 border-l-2 border-muted">
          {thread.answers.map((a) => (
            <div key={a.id} className="text-sm py-2">
              <p>{a.content}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {new Date(a.createdAt).toLocaleString('ja-JP')}
              </p>
            </div>
          ))}
          {thread.answers.length === 0 && (
            <p className="text-xs text-muted-foreground">まだ回答がありません</p>
          )}
          {canSubmit && (
            <div className="flex gap-2">
              <textarea
                className="flex-1 rounded border px-3 py-1.5 text-sm resize-none"
                placeholder="匿名で回答..."
                rows={2}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
              />
              <Button
                size="sm"
                onClick={handleAnswer}
                disabled={submitting || !answer.trim()}
              >
                回答
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
