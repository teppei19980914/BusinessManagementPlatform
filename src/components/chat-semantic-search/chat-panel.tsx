'use client';

/**
 * チャット意味検索のサイドパネル。
 *
 * 仕様: docs/specification/CHAT_SEMANTIC_SEARCH.md §3 / §6
 *   - 入力欄: Enter 送信、Shift+Enter 改行、8000 字上限
 *   - 10 字未満は警告表示 (送信は常時可能)
 *   - 結果表示: tier (strong/medium/weak) 段階表示
 *       - strong: 初期 5 件、6 件目以降はアコーディオン展開
 *       - medium: デフォルト折りたたみ
 *       - weak  : デフォルト折りたたみ
 *   - 縮退モード時は注意バナー表示
 *   - 会話履歴は sessionStorage で「同一タブの 1 セッション中のみ」保持
 *     (タブを閉じる / ログアウト / 履歴クリアボタンで消去)
 *
 * PR fix/chat-search-and-auto-open (2026-05-24) で導入された UX 改善:
 *   - C-2: 連続送信時の AbortController で前回 fetch を破棄 (race 解消)
 *   - C-3: 結果カードクリック時の navigation pending 状態を useTransition で表現
 *   - C-4: useSession().status === 'loading' 中は memo カードを disable (誤遷移防止)
 *
 * feat/chat-history-and-accordion (2026-05-28) で導入された UX 改善:
 *   - H-1: 会話履歴の sessionStorage 永続化 (タブ単位揮発、DB 容量を消費しない)
 *   - H-2: ログアウト時に sessionStorage を明示クリア (session.status 監視)
 *   - H-3: strong tier の初期 5 件 + アコーディオンで 6 件目以降を可視化
 *   - H-4: medium tier をデフォルト折りたたみに変更 + 「関連の可能性」を「中程度の関連」へ改称
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react';
import Image from 'next/image';
import { useSession } from 'next-auth/react';
import { cn } from '@/lib/utils';
import {
  CHAT_SEARCH_INPUT_MAX_CHARS,
  CHAT_SEARCH_INPUT_WARN_THRESHOLD,
} from '@/config/suggestion';
import { CHAT_PERSONA } from '@/config';
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

/**
 * 1 つの会話ターン (ユーザ発言 + フクロウの応答) を表す型。
 * status は派生計算: result も error も無ければ pending (検索中)。
 */
type ChatTurn = {
  id: string;
  userQuery: string;
  result?: ChatSearchResult;
  error?: string;
};

/**
 * sessionStorage の key。バージョン番号は schema 互換性が破れた時に増やす。
 * 旧 key のデータは parse 失敗 → 空配列フォールバックで自動的に切り捨てられる。
 */
const HISTORY_STORAGE_KEY = 'tasukiba_chat_history_v1';

/** strong tier の初期表示件数。これを超えるとアコーディオン折りたたみ。 */
const STRONG_INITIAL_VISIBLE = 5;

/**
 * 保持する会話ターンの上限件数。
 * sessionStorage の 5MB 制限 + DOM ノード数の暴走 + DevTools 改ざんによる UI freeze 攻撃を防ぐ。
 * 1 ターンあたり result 込みで ~50KB 程度想定 (最大資産 250 件 × snippet 120 字 × 5 資産)、
 * 50 ターンで ~2.5MB → 5MB 上限の半分以下に収まる。
 */
const MAX_HISTORY_TURNS = 50;

/**
 * sessionStorage から会話履歴を読む。SSR safe (window 未定義時は []。)。
 * parse 失敗 / shape 不整合 / quota 等の全異常を graceful degradation で吸収する。
 * DevTools での turns 大量挿入攻撃を防ぐため、読込時にも MAX_HISTORY_TURNS で trim する
 * (saveHistory 側だけでなく load 側でも防御 = defense-in-depth)。
 */
function loadHistory(): ChatTurn[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(
      (item): item is ChatTurn =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as { id?: unknown }).id === 'string' &&
        typeof (item as { userQuery?: unknown }).userQuery === 'string',
    );
    // 件数上限を超えるデータは古いものから捨てる (= 攻撃者の DevTools 挿入を無効化)。
    return valid.length > MAX_HISTORY_TURNS ? valid.slice(-MAX_HISTORY_TURNS) : valid;
  } catch {
    return [];
  }
}

/**
 * sessionStorage への保存。quota exceeded 等の例外は黙って捨てる (機能継続優先)。
 * 件数上限 MAX_HISTORY_TURNS を超えていたら古いものから捨てて保存する。
 */
function saveHistory(turns: ChatTurn[]): void {
  if (typeof window === 'undefined') return;
  try {
    const trimmed =
      turns.length > MAX_HISTORY_TURNS ? turns.slice(-MAX_HISTORY_TURNS) : turns;
    window.sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // QuotaExceededError 等。揮発するだけで動作には影響しない。
  }
}

/** sessionStorage からの明示削除。ログアウト / 手動クリア時に呼ばれる。 */
function clearHistory(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(HISTORY_STORAGE_KEY);
  } catch {
    // noop
  }
}

/** ChatTurn 用の id 生成。crypto.randomUUID が無い環境のフォールバック付き。 */
function generateTurnId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // H-1: 会話履歴を配列で保持。lazy init で sessionStorage から復元する。
  const [turns, setTurns] = useState<ChatTurn[]>(() => loadHistory());
  // C-3: 結果カードクリック後の navigation 中フラグ。useTransition の isPending で
  //   「click → auto-open dialog 表示」の間ユーザに視覚フィードバックを返す。
  const [isNavigating, startNavigation] = useTransition();
  // C-2: 連続送信時のレース解消用 AbortController を保持。新規送信時に前回をキャンセル。
  const inFlightAbortRef = useRef<AbortController | null>(null);
  // C-4: session 取得状態。'loading' 中は viewerUserId が undefined のため、
  //   memo カードクリックで「自分の private memo」が誤って /all-memos に倒れる罠を避ける。
  const session = useSession();
  const viewerUserId = session.data?.user?.id;
  const sessionLoading = session.status === 'loading';
  // H-2: ログアウト時 (= 'unauthenticated' 遷移時) に sessionStorage を明示クリア。
  const isUnauthenticated = session.status === 'unauthenticated';
  // 最新メッセージへ自動スクロールするためのアンカー。
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);

  const showWarning = query.length > 0 && query.length < CHAT_SEARCH_INPUT_WARN_THRESHOLD;
  const tooLong = query.length > CHAT_SEARCH_INPUT_MAX_CHARS;

  // H-1: turns が変わるたびに sessionStorage に書き戻す。
  // 別経路 (signOut callback 等) で消えた後の復活を避けるため、isUnauthenticated 中は skip。
  useEffect(() => {
    if (isUnauthenticated) return;
    saveHistory(turns);
  }, [turns, isUnauthenticated]);

  // H-2: ログアウト遷移を検知したら storage + state を両方クリア。
  // Cookie 削除に依存せず client-side で履歴を確実に消す ([feedback_session_clearance_pattern] 思想)。
  useEffect(() => {
    if (isUnauthenticated) {
      clearHistory();
      // setState 呼出は意図的: auth ライフサイクルと React state を橋渡しする一回限りの遷移処理であり、
      // isUnauthenticated 遷移後は state も [] に揃うため cascading render は発生しない。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTurns([]);
    }
  }, [isUnauthenticated]);

  // H-5 (severity-1 user crossover defense, 2026-05-28):
  // 同一タブで「ユーザ A サインアウト → ユーザ B サインイン」シナリオに対する追加防御。
  // NextAuth v5 が visibilitychange / Set-Cookie 経由で session を差し替えた時、
  // 'unauthenticated' を経由せずに viewerUserId だけが切り替わるケースがある。
  // H-2 (unauthenticated 検知) では拾えないため、viewerUserId の遷移そのものを監視する。
  // 旧 ID から新 ID への変化 (= 別ユーザログイン) を検知したら、A の履歴を確実に消す。
  // null/undefined → 値、値 → null/undefined の遷移は H-2 / 初期化処理で扱うので対象外。
  const prevUserIdRef = useRef<string | undefined>(viewerUserId);
  useEffect(() => {
    const prev = prevUserIdRef.current;
    if (prev !== undefined && viewerUserId !== undefined && prev !== viewerUserId) {
      clearHistory();
      // 別ユーザの履歴を即座に画面から消すための同期 setState。一度限りの境界遷移処理。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTurns([]);
    }
    prevUserIdRef.current = viewerUserId;
  }, [viewerUserId]);

  // 最新ターンの状態変化 (新規追加 / result 到着 / error) に追従して下端へスクロール。
  // turns.length と「最終ターンの status」を依存に含め、結果到着のタイミングでも reflow する。
  const lastTurn = turns[turns.length - 1];
  const lastTurnHasResult = !!lastTurn?.result;
  const lastTurnHasError = !!lastTurn?.error;
  useEffect(() => {
    bottomAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, lastTurnHasResult, lastTurnHasError]);

  // unmount 時 (= パネル閉じる) に in-flight fetch を確実に abort する。
  useEffect(() => {
    return () => {
      inFlightAbortRef.current?.abort();
    };
  }, []);

  const handleSubmit = useCallback(async () => {
    if (submitting || query.trim().length === 0 || tooLong) return;

    // C-2: 前回 in-flight があれば abort。連投時の race 防止。
    inFlightAbortRef.current?.abort();
    const ac = new AbortController();
    inFlightAbortRef.current = ac;

    const turnId = generateTurnId();
    const submittedQuery = query;

    setSubmitting(true);
    // ユーザ発言を即時に履歴へ追加 (= optimistic add)。応答到着時に同 id を update する。
    setTurns((prev) => [...prev, { id: turnId, userQuery: submittedQuery }]);
    // 送信後に入力欄をクリア (LINE / Teams パターン)。次の質問にすぐ移れる。
    setQuery('');

    try {
      const res = await fetch('/api/chat/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: submittedQuery }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        const message = body.error?.message ?? `検索に失敗しました (${res.status})`;
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId ? { ...t, error: message } : t)),
        );
      } else {
        const body = (await res.json()) as { data: ChatSearchResult };
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId ? { ...t, result: body.data } : t)),
        );
      }
    } catch (e) {
      // abort された fetch は AbortError を throw する。意図的な cancel なのでエラー扱いしない。
      if (e instanceof DOMException && e.name === 'AbortError') {
        return;
      }
      const message = e instanceof Error ? e.message : '検索に失敗しました';
      setTurns((prev) =>
        prev.map((t) => (t.id === turnId ? { ...t, error: message } : t)),
      );
    } finally {
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
  const handleCardClick = useCallback(() => {
    startNavigation(() => {
      // body は空でも startTransition の登録自体が isPending を立てる。
    });
  }, []);

  // 履歴クリア (手動)。ユーザが明示的に「過去の会話を消したい」と意思表示した場合に呼ばれる。
  const handleClearHistory = useCallback(() => {
    clearHistory();
    setTurns([]);
  }, []);

  return (
    <aside
      role="complementary"
      aria-label="チャット意味検索"
      className="fixed inset-y-0 right-0 z-40 flex h-full w-full max-w-md flex-col border-l border-border bg-background shadow-xl"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        {/*
          2026-05-27 デザイン更新: 「ユーザは誰と会話しているか」を明示するため、
          ヘッダにアシスタント・ペルソナ (たすきフクロウ) のアバターと表示名を提示。
        */}
        <div className="flex items-center gap-2">
          {/*
            ヘッダ avatar: ChatPanel 自体が `{open && <ChatPanel>}` で user 操作後に
            初めて mount されるため、初期ページロード時の LCP 候補ではない。
            priority を付けると未使用 preload で WAS bandwidth を浪費する (KDD §5.X+166)。
            FAB 側で同じ /mascot-owl-chat.png を priority 表示しており、その時点で
            HTTP cache に乗っているため遅延描画は事実上ない。
          */}
          <Image
            src={CHAT_PERSONA.avatarSrc}
            alt={CHAT_PERSONA.avatarAlt}
            width={36}
            height={36}
            className="h-9 w-9 rounded-full object-cover"
            data-testid="chat-panel-persona-avatar"
          />
          <div className="flex flex-col">
            <span className="text-sm font-semibold leading-tight" data-testid="chat-panel-persona-name">
              {CHAT_PERSONA.name}
            </span>
            <span className="text-[10px] text-muted-foreground leading-tight">
              過去資産を意味検索
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {/* H-1: 履歴クリアボタン。turns が空なら disable して操作の意味を視覚化。 */}
          <button
            type="button"
            onClick={handleClearHistory}
            disabled={turns.length === 0}
            aria-label="会話履歴をクリア"
            title="会話履歴をクリア"
            data-testid="chat-panel-clear-history"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          >
            🗑️
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            ✕
          </button>
        </div>
      </header>

      {/*
        Voyage への外部送信を明示告知 (about.md §Q5 と整合)。
      */}
      <div className="border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
        ⓘ クエリ内容は意味検索のため外部 AI サービス (Voyage AI)
        に送信されます。機微情報の入力はお控えください。
      </div>

      <div className="flex-1 overflow-y-auto p-4 text-sm" data-testid="chat-panel-messages">
        {/*
          フクロウの初期挨拶は turns の有無に関わらず常時表示する。
          - 初期表示時: 唯一のメッセージとして表示
          - 質問後: 会話履歴の最上部に残り、対話の起点として読める
          - 🗑️ クリア時: turns が [] に戻るため、初期挨拶のみが残る状態 (= 初期表示と同じ)
          data-testid="chat-initial-greeting" でテスト・UX 検証から参照可能。
        */}
        <AssistantBubble>
          <div data-testid="chat-initial-greeting">
            <p className="leading-relaxed">
              こんにちは、{CHAT_PERSONA.name}です。
            </p>
            <p className="mt-1 leading-relaxed">
              気になることや知りたいことをチャットしてください。
              プロジェクト・ナレッジ・リスク・課題・振り返り・メモから、
              私が適切な情報を探してご提案します。
            </p>
          </div>
        </AssistantBubble>

        {/*
          会話履歴を時系列順 (古い→新しい) で連続描画。
          各 ChatTurnView が独立に strong/medium/weak のアコーディオン状態を保持する。
        */}
        {turns.map((turn) => (
          <ChatTurnView
            key={turn.id}
            turn={turn}
            viewerUserId={viewerUserId}
            sessionLoading={sessionLoading}
            onCardClick={handleCardClick}
          />
        ))}

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

        {/* 自動スクロールアンカー */}
        <div ref={bottomAnchorRef} />
      </div>

      <footer className="border-t border-border p-3">
        {showWarning && (
          <div className="mb-2 text-xs text-warning-foreground">
            もう少し詳しく書いていただけると、より精度の高い提案ができます
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

/**
 * 1 会話ターン (ユーザ発言 + フクロウの応答) のレンダリング。
 * 各ターンが独立に strong/medium/weak のアコーディオン状態を保持する設計のため、
 * 過去ターンを再展開しても他ターンには影響しない。
 */
function ChatTurnView({
  turn,
  viewerUserId,
  sessionLoading,
  onCardClick,
}: {
  turn: ChatTurn;
  viewerUserId: string | undefined;
  sessionLoading: boolean;
  onCardClick: () => void;
}) {
  // H-3: strong tier の「6 件目以降」を見せるかどうか (初期 false)。
  const [strongExpanded, setStrongExpanded] = useState(false);
  // H-4: medium tier をデフォルト折りたたみに変更 (旧仕様: 常時開)。
  const [mediumExpanded, setMediumExpanded] = useState(false);
  // weak tier は既存仕様どおりデフォルト折りたたみ。
  const [weakExpanded, setWeakExpanded] = useState(false);

  const pending = !turn.result && !turn.error;

  return (
    <>
      <UserBubble text={turn.userQuery} />
      {turn.error ? (
        // エラー時は AssistantBubble を出さずに error バナーのみ表示 (LINE/Teams の通知パターン)。
        <div
          role="alert"
          className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {turn.error}
        </div>
      ) : pending ? (
        <AssistantBubble>
          <div className="text-xs text-muted-foreground" role="status" aria-live="polite">
            ⏳ ちょっと待ってくださいね、過去資産から探しています…
          </div>
        </AssistantBubble>
      ) : turn.result ? (
        <AssistantBubble>
          {turn.result.degraded && turn.result.degradeReason && (
            <div className="mb-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
              💡 ごめんなさい、AI 機能が一時的に使えないようです ({DEGRADED_REASON_LABEL[turn.result.degradeReason]})。
              テキスト類似度だけで探しますね。
            </div>
          )}
          <ChatResults
            result={turn.result}
            viewerUserId={viewerUserId}
            sessionLoading={sessionLoading}
            strongExpanded={strongExpanded}
            mediumExpanded={mediumExpanded}
            weakExpanded={weakExpanded}
            onToggleStrong={() => setStrongExpanded((v) => !v)}
            onToggleMedium={() => setMediumExpanded((v) => !v)}
            onToggleWeak={() => setWeakExpanded((v) => !v)}
            onCardClick={onCardClick}
          />
        </AssistantBubble>
      ) : null}
    </>
  );
}

/**
 * 右寄せ ユーザ発言バブル。LINE / Teams 等と同じ「自分の発言は右側」レイアウト。
 */
function UserBubble({ text }: { text: string }) {
  return (
    <div className="mb-3 flex justify-end" data-testid="chat-user-bubble">
      <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-3 py-2 text-sm text-primary-foreground whitespace-pre-wrap break-words">
        {text}
      </div>
    </div>
  );
}

/**
 * 左寄せ アシスタント発言吹き出し。アバター (たすきフクロウ) + 吹き出しの 2 カラム。
 * 結果カード群を 1 つの吹き出し内にネストすることで「フクロウが提案を返した」体験を作る。
 */
function AssistantBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-start gap-2" data-testid="chat-assistant-bubble">
      {/*
        装飾用アバター: alt="" のみで AT は無視するため aria-hidden は不要 (冗長指定の回避)。
        object-cover でバッジ自体が全面を占めるよう確実にトリミング (KDD §5.X+165)。
      */}
      <Image
        src={CHAT_PERSONA.avatarSrc}
        alt=""
        width={32}
        height={32}
        className="mt-1 h-8 w-8 shrink-0 rounded-full object-cover"
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

function ChatResults({
  result,
  viewerUserId,
  sessionLoading,
  strongExpanded,
  mediumExpanded,
  weakExpanded,
  onToggleStrong,
  onToggleMedium,
  onToggleWeak,
  onCardClick,
}: {
  result: ChatSearchResult;
  viewerUserId: string | undefined;
  sessionLoading: boolean;
  strongExpanded: boolean;
  mediumExpanded: boolean;
  weakExpanded: boolean;
  onToggleStrong: () => void;
  onToggleMedium: () => void;
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
        💡 うーん、関連する資産は見つかりませんでした…別の言葉でも試してみてください。
        {result.fileScopeApplied && (
          <div className="mt-1 text-xs">
            ※ 添付ファイルに絞って探しました (「ファイル」「添付」「PDF」等のキーワードを検出した場合)
          </div>
        )}
      </div>
    );
  }

  // tier 別にグルーピング (全 5 資産横断でソート)
  const strong = allHits.filter((h) => h.tier === 'strong').sort((a, b) => b.score - a.score);
  const medium = allHits.filter((h) => h.tier === 'medium').sort((a, b) => b.score - a.score);
  const weak = allHits.filter((h) => h.tier === 'weak').sort((a, b) => b.score - a.score);

  // H-3: strong tier の表示分割。初期は上位 STRONG_INITIAL_VISIBLE 件、それ以降は折りたたみ。
  const strongInitial = strong.slice(0, STRONG_INITIAL_VISIBLE);
  const strongRest = strong.slice(STRONG_INITIAL_VISIBLE);

  // C-4: session 読み込み中は memo リンクを disable する判定関数。
  const isCardDisabled = (hit: ChatSearchHit): boolean =>
    sessionLoading && hit.kind === 'memo';

  return (
    <div>
      {result.fileScopeApplied && (
        <div className="mb-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
          📎 「ファイル」「添付」「PDF」等のキーワードを検出したので、添付ファイルに絞って探しました。
        </div>
      )}
      <div className="mb-3 text-xs text-muted-foreground">
        💡 {result.totalCount}件{result.fileScopeApplied ? 'の添付ファイル' : 'の関連資産'}を見つけました。関連が強い順にご紹介しますね。
      </div>

      {strong.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-2 text-xs font-semibold text-foreground">
            ▼ 強く関連 ({strong.length}件)
          </h3>
          <div className="flex flex-col gap-2">
            {strongInitial.map((hit) => (
              <ChatSearchResultCard
                key={`${hit.kind}-${hit.id}`}
                hit={hit}
                viewerUserId={viewerUserId}
                disabled={isCardDisabled(hit)}
                onClick={onCardClick}
              />
            ))}
            {strongRest.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={onToggleStrong}
                  aria-expanded={strongExpanded}
                  data-testid="chat-toggle-strong-rest"
                  className="mt-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  {strongExpanded
                    ? `▼ さらに表示中 (${strongRest.length}件)`
                    : `▶ さらに ${strongRest.length}件を表示`}
                </button>
                {strongExpanded &&
                  strongRest.map((hit) => (
                    <ChatSearchResultCard
                      key={`${hit.kind}-${hit.id}`}
                      hit={hit}
                      viewerUserId={viewerUserId}
                      disabled={isCardDisabled(hit)}
                      onClick={onCardClick}
                    />
                  ))}
              </>
            )}
          </div>
        </section>
      )}

      {medium.length > 0 && (
        <section className="mb-4">
          {/* H-4: 「関連の可能性」 → 「中程度の関連」 + デフォルト折りたたみ */}
          <button
            type="button"
            onClick={onToggleMedium}
            aria-expanded={mediumExpanded}
            data-testid="chat-toggle-medium"
            className="mb-2 text-xs font-semibold text-foreground hover:text-muted-foreground"
          >
            {mediumExpanded ? '▼' : '▶'} 中程度の関連 ({medium.length}件)
          </button>
          {mediumExpanded && (
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
          )}
        </section>
      )}

      {weak.length > 0 && (
        <section>
          <button
            type="button"
            onClick={onToggleWeak}
            aria-expanded={weakExpanded}
            data-testid="chat-toggle-weak"
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
