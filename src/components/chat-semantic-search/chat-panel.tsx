'use client';

/**
 * チャット意味検索のサイドパネル。
 *
 * 仕様: docs/specification/CHAT_SEMANTIC_SEARCH.md §3 / §6
 *   - 入力欄: Enter 送信、Shift+Enter 改行、8000 字上限
 *   - 10 字未満は警告表示 (送信は常時可能)
 *   - 結果表示: tier (strong/medium/weak) 段階表示、weak は折りたたみ
 *   - 縮退モード時は注意バナー表示
 *   - 会話履歴は永続化なし (Client State のみ)
 */

import { useCallback, useState } from 'react';
import { useSession } from 'next-auth/react';
import { cn } from '@/lib/utils';
import {
  CHAT_SEARCH_INPUT_MAX_CHARS,
  CHAT_SEARCH_INPUT_WARN_THRESHOLD,
} from '@/config/suggestion';
import type {
  ChatSearchHit,
  ChatSearchResult,
} from '@/services/chat-search.service';
import { ChatSearchResultCard } from './result-card';

type DegradedReason = NonNullable<ChatSearchResult['degradeReason']>;

const DEGRADED_REASON_LABEL: Record<DegradedReason, string> = {
  rate_limited: 'リクエストが多すぎます',
  beginner_limit_exceeded: '月間 API 呼出上限に達しました',
  budget_exceeded: '月次予算上限に達しました',
  tenant_inactive: 'テナントが無効です',
  plan_invalid: 'プラン設定が不正です',
  llm_error: 'AI サービスで一時的な問題が発生しています',
  output_invalid: 'クエリ処理に失敗しました',
};

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ChatSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [weakExpanded, setWeakExpanded] = useState(false);
  // memo の hit が「自分のメモ」か「他人 public」かで遷移先を分けるための viewerUserId。
  // session 未取得の間は undefined → 安全側で /all-memos に倒れる (chat-search-link.ts)。
  const viewerUserId = useSession().data?.user?.id;

  const showWarning = query.length > 0 && query.length < CHAT_SEARCH_INPUT_WARN_THRESHOLD;
  const tooLong = query.length > CHAT_SEARCH_INPUT_MAX_CHARS;

  const handleSubmit = useCallback(async () => {
    if (submitting || query.trim().length === 0 || tooLong) return;
    setSubmitting(true);
    setError(null);
    setSubmittedQuery(query);
    setWeakExpanded(false);
    try {
      const res = await fetch('/api/chat/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        setError(body.error?.message ?? `検索に失敗しました (${res.status})`);
        setResult(null);
      } else {
        const body = (await res.json()) as { data: ChatSearchResult };
        setResult(body.data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '検索に失敗しました');
      setResult(null);
    } finally {
      setSubmitting(false);
    }
  }, [query, submitting, tooLong]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <aside
      role="complementary"
      aria-label="チャット意味検索"
      className="fixed inset-y-0 right-0 z-40 flex h-full w-full max-w-md flex-col border-l border-border bg-background shadow-xl"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">💬 過去資産を意味検索</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="閉じる"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ✕
        </button>
      </header>

      {/*
        Voyage への外部送信を明示告知 (about.md §Q5 と整合)。
        ユーザがクエリ文の機微情報を含めるリスクを認識できるよう、常時表示する。
      */}
      <div className="border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
        ⓘ クエリ内容は意味検索のため外部 AI サービス (Voyage AI)
        に送信されます。機微情報の入力はお控えください。
      </div>

      <div className="flex-1 overflow-y-auto p-4 text-sm">
        {result?.degraded && result.degradeReason && (
          <div className="mb-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
            💡 AI 機能は一時的に制限されています ({DEGRADED_REASON_LABEL[result.degradeReason]})。
            テキスト類似度のみで検索します。
          </div>
        )}

        {submittedQuery && (
          <div className="mb-3">
            <div className="mb-1 text-xs font-medium text-muted-foreground">あなた:</div>
            <div className="rounded-md bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
              {submittedQuery}
            </div>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </div>
        )}

        {result && !error && (
          <ChatResults
            result={result}
            viewerUserId={viewerUserId}
            weakExpanded={weakExpanded}
            onToggleWeak={() => setWeakExpanded((v) => !v)}
          />
        )}

        {!submittedQuery && !error && (
          <div className="text-xs text-muted-foreground">
            自然文で過去のプロジェクト・ナレッジ・リスク・課題・振り返り・メモを意味検索できます。
          </div>
        )}
      </div>

      <footer className="border-t border-border p-3">
        {showWarning && (
          <div className="mb-2 text-xs text-warning-foreground">
            ⚠️ クエリが短いと検索精度が下がる可能性があります
          </div>
        )}
        {tooLong && (
          <div className="mb-2 text-xs text-destructive">
            クエリは {CHAT_SEARCH_INPUT_MAX_CHARS} 文字以内にしてください
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={submitting}
            placeholder="過去の似た案件で発生したリスクは?"
            rows={2}
            className={cn(
              'flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm',
              'focus:outline-none focus:ring-2 focus:ring-ring',
              'disabled:opacity-50',
            )}
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || query.trim().length === 0 || tooLong}
            aria-label="送信"
            className={cn(
              'h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground',
              'hover:bg-primary/80 disabled:opacity-50 disabled:hover:bg-primary',
            )}
          >
            {submitting ? '検索中...' : '送信→'}
          </button>
        </div>
      </footer>
    </aside>
  );
}

function ChatResults({
  result,
  viewerUserId,
  weakExpanded,
  onToggleWeak,
}: {
  result: ChatSearchResult;
  viewerUserId: string | undefined;
  weakExpanded: boolean;
  onToggleWeak: () => void;
}) {
  const allHits: ChatSearchHit[] = [
    ...result.results.projects,
    ...result.results.knowledges,
    ...result.results.risksIssues,
    ...result.results.retrospectives,
    ...result.results.memos,
  ];

  if (allHits.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/50 px-3 py-4 text-center text-xs text-muted-foreground">
        💡 関連する資産が見つかりませんでした
      </div>
    );
  }

  // tier 別にグルーピング (全 5 資産横断でソート)
  const strong = allHits.filter((h) => h.tier === 'strong').sort((a, b) => b.score - a.score);
  const medium = allHits.filter((h) => h.tier === 'medium').sort((a, b) => b.score - a.score);
  const weak = allHits.filter((h) => h.tier === 'weak').sort((a, b) => b.score - a.score);

  return (
    <div>
      <div className="mb-3 text-xs text-muted-foreground">
        💡 {result.totalCount}件の関連資産が見つかりました
      </div>

      {strong.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-2 text-xs font-semibold text-foreground">
            ▼ 強く関連 ({strong.length}件)
          </h3>
          <div className="flex flex-col gap-2">
            {strong.map((hit) => (
              <ChatSearchResultCard key={`${hit.kind}-${hit.id}`} hit={hit} viewerUserId={viewerUserId} />
            ))}
          </div>
        </section>
      )}

      {medium.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-2 text-xs font-semibold text-foreground">
            ▼ 関連の可能性 ({medium.length}件)
          </h3>
          <div className="flex flex-col gap-2">
            {medium.map((hit) => (
              <ChatSearchResultCard key={`${hit.kind}-${hit.id}`} hit={hit} viewerUserId={viewerUserId} />
            ))}
          </div>
        </section>
      )}

      {weak.length > 0 && (
        <section>
          <button
            type="button"
            onClick={onToggleWeak}
            aria-expanded={weakExpanded}
            className="mb-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
          >
            {weakExpanded ? '▼' : '▶'} 弱い関連性 ({weak.length}件)
          </button>
          {weakExpanded && (
            <div className="flex flex-col gap-2">
              {weak.map((hit) => (
                <ChatSearchResultCard key={`${hit.kind}-${hit.id}`} hit={hit} viewerUserId={viewerUserId} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
