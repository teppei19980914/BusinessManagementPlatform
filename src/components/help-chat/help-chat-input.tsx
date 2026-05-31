'use client';

/**
 * たすきフクロウ AI ヘルプチャット入力 component (PR6)。
 *
 * 役割:
 *   /help と /guide ページ上部に配置し、ユーザの質問を /api/help/chat に投げて
 *   フクロウの回答を表示する。既存 chat-semantic-search/chat-panel.tsx と設計を流用:
 *     - sessionStorage 履歴保持 (タブ単位揮発、最大 50 ターン)
 *     - ログアウト / ユーザ ID 変化時の clear ([[feedback_client_sessionstorage_user_isolation]])
 *     - AbortController による race 解消
 *     - Enter 送信 / Shift+Enter 改行
 *     - UserBubble / AssistantBubble + フクロウアバター
 *     - 口調パターン (「〜ですね」「うーん」「ごめんなさい」)
 *
 * 違い (チャット意味検索との差別化):
 *   - 結果カードではなく「FAQ の出典ジャンプリンク」を表示
 *   - answerType (faq / guide-walkthrough / out-of-scope / permission-denied) で UI 分岐
 *   - 上限到達 (429 + fallbackToAccordion) で入力欄 disable + アコーディオン誘導
 *
 * 関連:
 *   - 設計: docs/developer-guide/FAQ_AND_OWL_CHAT_GUIDE.md
 *   - 既存実装の参照: src/components/chat-semantic-search/chat-panel.tsx
 *   - API: src/app/api/help/chat/route.ts
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { useSession } from 'next-auth/react';
import { cn } from '@/lib/utils';
import { CHAT_PERSONA } from '@/config';
import type { HelpChatOutput } from '@/app/api/help/chat/route';
import {
  HELP_CHAT_HISTORY_BASE_KEY,
  loadScopedHistory,
  saveScopedHistory,
  clearScopedHistory,
  purgeOtherUsersHistory,
  purgeAllHistory,
} from '@/lib/chat-history-storage';

const MAX_HISTORY_TURNS = 50;
const MAX_QUERY_CHARS = 2000;

// G1-f (2026-05-31): 初期状態 (会話 0 件) で表示する質問例チップ。
//   ★全ロールで必ず回答が返る visibleTo='all' の例のみ★ にする (権限外の例を出すと
//   一般ロールが permission-denied で弾かれ「使えない」印象になるため)。
//   - 「最初に何をすればいいですか?」→ getting-started-what-to-do (all)
//   - 「リスクと課題の違いは?」→ risk-vs-issue (all)
//   - 「データはどう扱われますか?」→ ai-data-sent / 他テナント分離 (all)
const EXAMPLE_QUERIES = [
  '最初に何をすればいいですか?',
  'リスクと課題の違いは?',
  'データはどう扱われますか?',
] as const;

type HelpChatTurn = {
  id: string;
  userQuery: string;
  result?: HelpChatOutput & { requestId: string };
  error?: { message: string; fallbackToAccordion?: boolean };
};

/** HelpChatTurn の最小 shape ガード (load 時の trim/検証に使用)。 */
function isHelpChatTurn(item: unknown): item is HelpChatTurn {
  return (
    item !== null &&
    typeof item === 'object' &&
    typeof (item as { id?: unknown }).id === 'string' &&
    typeof (item as { userQuery?: unknown }).userQuery === 'string'
  );
}

function generateTurnId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `help-turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export type HelpChatInputProps = {
  /** UI バリエーション。'page' は /help/guide ページ上部用 (デフォルト)。'panel' は FAB タブ用 */
  variant?: 'page' | 'panel';
  /** 初期挨拶文の上書き (デフォルト: 共通のフクロウ挨拶) */
  greeting?: string;
  /**
   * ChatPanel のタブ内に埋め込む時、ChatPanel 側のヘッダで「アバター + たすきフクロウ + クリアボタン」を
   * 一元化するため本コンポーネントの自前ヘッダを suppress する。
   * `variant='panel'` 用途で ChatPanel が true を渡す ([feedback_sibling_ui_pattern_horizontal_rollout] 整合)。
   */
  hideHeader?: boolean;
  /**
   * turns 数の変化を ChatPanel に通知 (= 親側でクリアボタン disabled 判定に使う)。
   */
  onTurnsCountChange?: (count: number) => void;
};

export function HelpChatInput({
  variant = 'page',
  greeting,
  hideHeader = false,
  onTurnsCountChange,
}: HelpChatInputProps) {
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  // ★severity-1 ユーザ越境防御★: 履歴はユーザ ID 確定後にユーザスコープキーから復元する
  //   (固定キーの lazy init を廃止)。chat-panel.tsx と同一方式
  //   ([[feedback_client_sessionstorage_user_isolation]] / full-navigation 対策)。
  const [turns, setTurns] = useState<HelpChatTurn[]>([]);
  // 現ユーザ分で復元済かを表すゲート (復元前の空配列 clobber を防ぐ)。
  const [hydrated, setHydrated] = useState(false);
  // 直近に履歴を復元したユーザ ID (A→B 検知用)。
  const loadedUserRef = useRef<string | null>(null);
  const inFlightAbortRef = useRef<AbortController | null>(null);
  const session = useSession();
  const viewerUserId = session.data?.user?.id;
  const isUnauthenticated = session.status === 'unauthenticated';
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);

  const tooLong = query.length > MAX_QUERY_CHARS;

  // 親 (ChatPanel) に turns 数変化を通知 (= mode='help' のクリアボタン disabled 判定用)
  useEffect(() => {
    onTurnsCountChange?.(turns.length);
  }, [turns.length, onTurnsCountChange]);

  // load + ★severity-1 ユーザ越境防御 root fix★: viewerUserId 確定 (or A→B 変化) で
  //   他ユーザ分 (旧固定キー含む) を purge → 現ユーザのスコープキーから復元。
  useEffect(() => {
    if (!viewerUserId) return;
    if (loadedUserRef.current === viewerUserId) return;
    loadedUserRef.current = viewerUserId;
    purgeOtherUsersHistory(HELP_CHAT_HISTORY_BASE_KEY, viewerUserId);
    setTurns(loadScopedHistory(HELP_CHAT_HISTORY_BASE_KEY, viewerUserId, isHelpChatTurn, MAX_HISTORY_TURNS));
    setHydrated(true);
  }, [viewerUserId]);

  // persist: 復元後 (hydrated) かつ認証中のみ、現ユーザのスコープキーへ書き戻す。
  useEffect(() => {
    if (!hydrated || !viewerUserId || isUnauthenticated) return;
    saveScopedHistory(HELP_CHAT_HISTORY_BASE_KEY, viewerUserId, turns, MAX_HISTORY_TURNS);
  }, [turns, hydrated, viewerUserId, isUnauthenticated]);

  // ログアウト時の多層防御 clear (full-navigation が起きない SPA 内サインアウト経路向け)。
  useEffect(() => {
    if (!isUnauthenticated) return;
    purgeAllHistory(HELP_CHAT_HISTORY_BASE_KEY);
    loadedUserRef.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTurns([]);
    setHydrated(false);
  }, [isUnauthenticated]);

  // 最新ターンへ自動スクロール
  const lastTurn = turns[turns.length - 1];
  const lastTurnHasResult = !!lastTurn?.result;
  const lastTurnHasError = !!lastTurn?.error;
  useEffect(() => {
    bottomAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, lastTurnHasResult, lastTurnHasError]);

  // unmount 時に in-flight fetch を abort
  useEffect(() => {
    return () => {
      inFlightAbortRef.current?.abort();
    };
  }, []);

  const handleSubmit = useCallback(async () => {
    if (submitting || rateLimited || query.trim().length === 0 || tooLong) return;

    inFlightAbortRef.current?.abort();
    const ac = new AbortController();
    inFlightAbortRef.current = ac;

    const turnId = generateTurnId();
    const submittedQuery = query;

    setSubmitting(true);
    setTurns((prev) => [...prev, { id: turnId, userQuery: submittedQuery }]);
    setQuery('');

    try {
      const res = await fetch('/api/help/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: submittedQuery }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
          fallbackToAccordion?: boolean;
        };
        const message = body.error?.message ?? `応答に失敗しました (${res.status})`;
        const fallback = !!body.fallbackToAccordion;
        if (res.status === 429 && fallback) {
          setRateLimited(true);
        }
        setTurns((prev) =>
          prev.map((t) =>
            t.id === turnId ? { ...t, error: { message, fallbackToAccordion: fallback } } : t,
          ),
        );
      } else {
        const body = (await res.json()) as {
          data: HelpChatOutput & { requestId: string };
        };
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId ? { ...t, result: body.data } : t)),
        );
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return;
      }
      const message = e instanceof Error ? e.message : '応答に失敗しました';
      setTurns((prev) =>
        prev.map((t) => (t.id === turnId ? { ...t, error: { message } } : t)),
      );
    } finally {
      if (inFlightAbortRef.current === ac) {
        setSubmitting(false);
        inFlightAbortRef.current = null;
      }
    }
  }, [query, submitting, rateLimited, tooLong]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleClearHistory = useCallback(() => {
    if (!viewerUserId) return;
    clearScopedHistory(HELP_CHAT_HISTORY_BASE_KEY, viewerUserId);
    setTurns([]);
  }, [viewerUserId]);

  const defaultGreeting =
    'こんにちは、たすきフクロウです。\nお困りごとを教えてください。FAQ や使い方ガイドから一緒にお探ししますね。';

  // ADR-0028 PR #471 (2026-05-30): ChatPanel タブ内に埋め込む場合 (variant='panel') は、
  //   ChatPanel のヘッダ (アバター + persona + クリア + 閉じる) と footer (入力欄スタイル) を
  //   ★完全に同一の見た目に揃える★ ([feedback_sibling_ui_pattern_horizontal_rollout]:
  //   同じ機能を持つ UI は完全一致が原則。ユーザの美学要求)。
  //   page variant (`/help` / `/guide` 単独ページ) は自前のヘッダ + 枠付きメッセージ領域を維持。
  const isPanel = variant === 'panel';

  const containerClass = cn(
    isPanel
      ? 'flex h-full min-h-0 flex-col bg-background'
      : 'rounded-lg border bg-card p-4',
  );

  // メッセージ領域: panel は ChatPanel と完全一致 (枠なし、padding 4、flex-1 で残り全て)
  //                page  は従来通り (枠あり、max-h-96 で固定上限)
  const messagesClass = isPanel
    ? 'flex-1 min-h-0 overflow-y-auto p-4 text-sm'
    : 'max-h-96 min-h-0 flex-1 overflow-y-auto rounded-md border bg-background p-3 text-sm';

  // footer: panel は ChatPanel と完全一致 (上ボーダ + p-3)、page は mt-3 のみ
  const footerClass = isPanel ? 'border-t border-border p-3' : 'mt-3';

  return (
    <section
      aria-label="たすきフクロウ AI ヘルプチャット"
      className={containerClass}
      data-testid="help-chat-input"
    >
      {/*
        自前ヘッダ: page variant のみ表示。panel variant は ChatPanel のヘッダで一元化
        ([feedback_sibling_ui_pattern_horizontal_rollout]: 二重ヘッダは UI 不一致の原因)。
      */}
      {!hideHeader && (
        <header className="mb-3 flex items-center gap-2">
          <Image
            src={CHAT_PERSONA.avatarSrc}
            alt={CHAT_PERSONA.avatarAlt}
            width={32}
            height={32}
            className="h-8 w-8 rounded-full object-cover"
          />
          <div className="flex flex-col">
            <span className="text-sm font-semibold leading-tight">{CHAT_PERSONA.name}</span>
            <span className="text-[10px] text-muted-foreground leading-tight">
              FAQ・使い方ガイドからお答えします
            </span>
          </div>
          <button
            type="button"
            onClick={handleClearHistory}
            disabled={turns.length === 0}
            aria-label="会話履歴をクリア"
            title="会話履歴をクリア"
            data-testid="help-chat-clear-history"
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          >
            🗑️
          </button>
        </header>
      )}

      <div className={messagesClass} data-testid="help-chat-messages">
        <AssistantBubble>
          <p className="whitespace-pre-line leading-relaxed" data-testid="help-chat-initial-greeting">
            {greeting ?? defaultGreeting}
          </p>
        </AssistantBubble>

        {/* G1-f: 初期状態の質問例チップ (全ロール安全な all 段の例のみ)。クリックで入力欄に投入。 */}
        {turns.length === 0 && (
          <div
            className="mb-3 ml-9 flex flex-wrap gap-1.5"
            data-testid="help-chat-example-chips"
          >
            {EXAMPLE_QUERIES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => setQuery(ex)}
                disabled={submitting || rateLimited}
                className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {ex}
              </button>
            ))}
          </div>
        )}

        {turns.map((turn) => (
          <HelpChatTurnView key={turn.id} turn={turn} />
        ))}

        <div ref={bottomAnchorRef} />
      </div>

      {rateLimited && (
        <div
          role="alert"
          className={cn(
            'rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground',
            isPanel ? 'mx-3 mb-2' : 'mt-2',
          )}
        >
          💡 本月の利用上限に達しました。下記の FAQ 一覧から探してみてください (来月 1 日に再開します)。
        </div>
      )}

      <footer className={footerClass}>
        {tooLong && (
          <div className="mb-2 text-xs text-destructive">
            質問は {MAX_QUERY_CHARS} 文字以内にしてください
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={submitting || rateLimited}
            placeholder="例: 最初に何をすればいいですか? / リスクと課題の違いは?"
            rows={2}
            data-testid="help-chat-input-textarea"
            className={cn(
              'flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm',
              'focus:outline-none focus:ring-2 focus:ring-ring',
              'disabled:opacity-50',
            )}
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || rateLimited || query.trim().length === 0 || tooLong}
            aria-label="送信"
            data-testid="help-chat-submit"
            className={cn(
              'h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground',
              'hover:bg-primary/80 disabled:opacity-50 disabled:hover:bg-primary',
            )}
          >
            {submitting ? '考え中…' : '送信→'}
          </button>
        </div>
      </footer>
    </section>
  );
}

// ================================================================
// 内部 component
// ================================================================

function HelpChatTurnView({ turn }: { turn: HelpChatTurn }) {
  const pending = !turn.result && !turn.error;

  return (
    <>
      <UserBubble text={turn.userQuery} />
      {turn.error ? (
        <div
          role="alert"
          className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          🙏 {turn.error.message}
        </div>
      ) : pending ? (
        <AssistantBubble>
          <div className="text-xs text-muted-foreground" role="status" aria-live="polite">
            ⏳ ちょっと待ってくださいね、FAQ と使い方ガイドを探しています…
          </div>
        </AssistantBubble>
      ) : turn.result ? (
        <AssistantBubble>
          <AnswerCard result={turn.result} />
        </AssistantBubble>
      ) : null}
    </>
  );
}

function AnswerCard({ result }: { result: HelpChatOutput }) {
  const { answer, answerType, sourceFaqIds, sourceGuideStepIds, suggestSemanticSearch } = result;

  return (
    <div className="space-y-2">
      {answerType === 'guide-walkthrough' && (
        <div className="text-[10px] text-muted-foreground">📘 使い方ガイドより</div>
      )}
      {answerType === 'permission-denied' && (
        <div className="text-[10px] text-warning-foreground">🔒 開示制限</div>
      )}
      {answerType === 'out-of-scope' && (
        <div className="text-[10px] text-muted-foreground">💡 FAQ/ガイド外</div>
      )}
      <p className="whitespace-pre-line leading-relaxed" data-testid="help-chat-answer">
        {answer}
      </p>

      {suggestSemanticSearch && (
        <div className="mt-2 rounded-md border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs text-blue-700">
          📊 画面右下のチャットアイコン (たすきフクロウ) から過去資産を検索できます。
        </div>
      )}

      {(sourceFaqIds.length > 0 || sourceGuideStepIds.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
          {/* G2-d (2026-05-31): チャットは FAB に一本化され任意のページから開くため、
              旧 `#faq-{id}` 同一ページ内アンカー (help-client 側に未定義 = 不発) を廃止し、
              出典の種別ページ (FAQ → /help、ガイド → /guide) への遷移に修正する。
              /help では検索ボックスで当該 id の語を絞り込める。 */}
          {sourceFaqIds.map((id) => (
            <a
              key={`faq-${id}`}
              href="/help"
              data-testid="help-chat-source-faq-link"
              className="rounded-full border border-border bg-muted px-2 py-0.5 text-muted-foreground hover:text-foreground"
            >
              📖 FAQ: {id}
            </a>
          ))}
          {sourceGuideStepIds.map((id) => (
            <a
              key={`guide-${id}`}
              href="/guide"
              data-testid="help-chat-source-guide-link"
              className="rounded-full border border-border bg-muted px-2 py-0.5 text-muted-foreground hover:text-foreground"
            >
              📘 ガイド: {id}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="mb-3 flex justify-end" data-testid="help-chat-user-bubble">
      <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-3 py-2 text-sm text-primary-foreground whitespace-pre-wrap break-words">
        {text}
      </div>
    </div>
  );
}

function AssistantBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-start gap-2" data-testid="help-chat-assistant-bubble">
      <Image
        src={CHAT_PERSONA.avatarSrc}
        alt=""
        width={28}
        height={28}
        className="mt-1 h-7 w-7 shrink-0 rounded-full object-cover"
      />
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm bg-muted px-3 py-2 text-sm">
        <div className="mb-1 text-[10px] font-medium text-muted-foreground">
          {CHAT_PERSONA.name}
        </div>
        {children}
      </div>
    </div>
  );
}
