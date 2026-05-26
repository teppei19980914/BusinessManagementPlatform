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
 *
 * PR fix/chat-search-and-auto-open (2026-05-24) で追加された UX 改善:
 *   - C-2: 連続送信時の AbortController で前回 fetch を破棄 (race 解消)
 *   - C-3: 結果カードクリック時の navigation pending 状態を useTransition で表現
 *   - C-4: useSession().status === 'loading' 中は memo カードを disable (誤遷移防止)
 */

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
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
  // ADR-0019 (2026-05-24): チャット検索は無料化されたため、Beginner 上限 / 予算上限の判定からは
  //   除外される。本 2 ラベルはサーバ側の reason union 整合 (legacy) のため残す。
  //   通常の運用ではこの reason はチャット検索で発生しない。
  beginner_limit_exceeded: 'チャット検索は無料機能です (上限超過の通知が出た場合はサポートへ)',
  budget_exceeded: 'チャット検索は無料機能です (上限超過の通知が出た場合はサポートへ)',
  // ADR-0019: チャット検索 (= 無料 featureUnit) の月次 fair use limit (10,000 calls/tenant) 到達。
  fair_use_limit_exceeded: '無料機能の月間利用上限に達しました (来月自動再開)',
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
  // C-3: 結果カードクリック後の navigation 中フラグ。useTransition の isPending で
  //   「click → auto-open dialog 表示」の間ユーザに視覚フィードバックを返す。
  const [isNavigating, startNavigation] = useTransition();
  // C-2: 連続送信時のレース解消用 AbortController を保持。新規送信時に前回をキャンセル。
  //   旧実装は AbortController なしで、後着 fetch が先着 fetch を上書きする race があった
  //   (検索結果がクエリと不整合になる UX バグ)。
  const inFlightAbortRef = useRef<AbortController | null>(null);
  // C-4: session 取得状態。'loading' 中は viewerUserId が undefined のため、
  //   memo カードクリックで「自分の private memo」が誤って /all-memos に倒れる罠を避ける。
  const session = useSession();
  const viewerUserId = session.data?.user?.id;
  const sessionLoading = session.status === 'loading';

  const showWarning = query.length > 0 && query.length < CHAT_SEARCH_INPUT_WARN_THRESHOLD;
  const tooLong = query.length > CHAT_SEARCH_INPUT_MAX_CHARS;

  // unmount 時 (= パネル閉じる) に in-flight fetch を確実に abort する。
  // 閉じた後にレスポンスが返ってきても setState で memory leak / warning が出ない。
  useEffect(() => {
    return () => {
      inFlightAbortRef.current?.abort();
    };
  }, []);

  const handleSubmit = useCallback(async () => {
    if (submitting || query.trim().length === 0 || tooLong) return;

    // C-2: 前回 in-flight があれば abort。連投時に「後着結果が先着結果に勝つ race」防止。
    inFlightAbortRef.current?.abort();
    const ac = new AbortController();
    inFlightAbortRef.current = ac;

    setSubmitting(true);
    setError(null);
    setSubmittedQuery(query);
    setWeakExpanded(false);
    try {
      const res = await fetch('/api/chat/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: ac.signal,
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
      // abort された fetch は AbortError を throw する。意図的な cancel なので
      // ユーザに「失敗しました」を出さない (新しい検索が走っている)。
      if (e instanceof DOMException && e.name === 'AbortError') {
        return;
      }
      setError(e instanceof Error ? e.message : '検索に失敗しました');
      setResult(null);
    } finally {
      // 別 fetch が abort されて入れ替わっていたら、setSubmitting は新しい fetch が
      // 管理しているため触らない。ref 上の AbortController が一致するときのみ完了処理。
      if (inFlightAbortRef.current === ac) {
        setSubmitting(false);
        inFlightAbortRef.current = null;
      }
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

  // C-3: 結果カードに渡す onCardClick。Link の遷移を startTransition で wrap し、
  //   isPending=true の間 UI で「読み込み中」を見せる。
  //   Link の prefetch / 既定の navigation 動作は壊さない (e.preventDefault しない)。
  const handleCardClick = useCallback(() => {
    startNavigation(() => {
      // body は空でも startTransition の登録自体が isPending を立てる。
      // Link の onClick で startTransition を呼ぶと React が遷移を transition として扱う。
    });
  }, []);

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

        {/* C-3: 遷移中の global pending インジケータ */}
        {isNavigating && (
          <div
            role="status"
            aria-live="polite"
            className="mb-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
          >
            ⏳ 詳細を開いています...
          </div>
        )}

        {result && !error && (
          <ChatResults
            result={result}
            viewerUserId={viewerUserId}
            sessionLoading={sessionLoading}
            weakExpanded={weakExpanded}
            onToggleWeak={() => setWeakExpanded((v) => !v)}
            onCardClick={handleCardClick}
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
  sessionLoading,
  weakExpanded,
  onToggleWeak,
  onCardClick,
}: {
  result: ChatSearchResult;
  viewerUserId: string | undefined;
  sessionLoading: boolean;
  weakExpanded: boolean;
  onToggleWeak: () => void;
  onCardClick: () => void;
}) {
  // ADR-0021 (2026-05-26): file scope query 検出時は attachment のみ、それ以外は 5 資産横断
  const allHits: ChatSearchHit[] = result.fileScopeApplied
    ? [...result.results.attachments]
    : [
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
        {result.fileScopeApplied && (
          <div className="mt-1 text-xs">
            添付ファイルのみを対象に検索しました ({/* file scope mode の説明 */}
            「ファイル」「添付」「PDF」等のキーワード検出時に有効)
          </div>
        )}
      </div>
    );
  }

  // tier 別にグルーピング (全 5 資産横断でソート)
  const strong = allHits.filter((h) => h.tier === 'strong').sort((a, b) => b.score - a.score);
  const medium = allHits.filter((h) => h.tier === 'medium').sort((a, b) => b.score - a.score);
  const weak = allHits.filter((h) => h.tier === 'weak').sort((a, b) => b.score - a.score);

  // C-4: session 読み込み中は memo リンクを disable する判定関数。
  //   memo の hit は viewerUserId 比較で /memos vs /all-memos を振り分けるが、
  //   viewerUserId 未取得時は安全側で /all-memos に倒れる。これだと「自分の private memo」が
  //   /all-memos に表示されない (= 開いても見つからない) UX 事故になるため、
  //   session 取得完了まで memo カードクリック自体を抑止する。
  const isCardDisabled = (hit: ChatSearchHit): boolean => sessionLoading && hit.kind === 'memo';

  return (
    <div>
      {result.fileScopeApplied && (
        <div className="mb-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
          📎 添付ファイルのみを対象に検索しました (= 「ファイル」「添付」「PDF」等のキーワードを検出)
        </div>
      )}
      <div className="mb-3 text-xs text-muted-foreground">
        💡 {result.totalCount}件の{result.fileScopeApplied ? '添付ファイル' : '関連資産'}が見つかりました
      </div>

      {strong.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-2 text-xs font-semibold text-foreground">
            ▼ 強く関連 ({strong.length}件)
          </h3>
          <div className="flex flex-col gap-2">
            {strong.map((hit) => (
              <ChatSearchResultCard
                key={`${hit.kind}-${hit.id}`}
                hit={hit}
                viewerUserId={viewerUserId}
                disabled={isCardDisabled(hit)}
                onClick={onCardClick}
              />
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
              <ChatSearchResultCard
                key={`${hit.kind}-${hit.id}`}
                hit={hit}
                viewerUserId={viewerUserId}
                disabled={isCardDisabled(hit)}
                onClick={onCardClick}
              />
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
                <ChatSearchResultCard
                  key={`${hit.kind}-${hit.id}`}
                  hit={hit}
                  viewerUserId={viewerUserId}
                  disabled={isCardDisabled(hit)}
                  onClick={onCardClick}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
