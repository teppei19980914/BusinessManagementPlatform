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
import { useTranslations } from 'next-intl';
import { useSession } from 'next-auth/react';
import { cn } from '@/lib/utils';
import {
  CHAT_SEARCH_INPUT_MAX_CHARS,
  CHAT_SEARCH_INPUT_WARN_THRESHOLD,
  SUGGESTION_TIER_STRONG_INITIAL_VISIBLE,
} from '@/config/suggestion';
import { CHAT_PERSONA } from '@/config';
import type {
  ChatSearchHit,
  ChatSearchResult,
} from '@/services/chat-search.service';
import type { ProjectChatSearchResult } from '@/services/project-chat-search.service';
import { ChatSearchResultCard, ProjectChatSearchResultCard } from './result-card';
import { HelpChatInput } from '@/components/help-chat/help-chat-input';
import {
  CHAT_SEARCH_HISTORY_BASE_KEY,
  HELP_CHAT_HISTORY_BASE_KEY,
  loadScopedHistory,
  saveScopedHistory,
  clearScopedHistory,
  purgeOtherUsersHistory,
  purgeAllHistory,
} from '@/lib/chat-history-storage';

const PROJECT_SEARCH_HISTORY_BASE_KEY = 'tasukiba_pj_search_v1';

type DegradedReason = NonNullable<ChatSearchResult['degradeReason']>;
type ProjectDegradedReason = NonNullable<ProjectChatSearchResult['degradeReason']>;

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

type ProjectChatTurn = {
  id: string;
  userQuery: string;
  result?: ProjectChatSearchResult;
  error?: string;
};

/**
 * 保持する会話ターンの上限件数。
 * sessionStorage の 5MB 制限 + DOM ノード数の暴走 + DevTools 改ざんによる UI freeze 攻撃を防ぐ。
 * 1 ターンあたり result 込みで ~50KB 程度想定 (最大資産 250 件 × snippet 120 字 × 5 資産)、
 * 50 ターンで ~2.5MB → 5MB 上限の半分以下に収まる。
 */
const MAX_HISTORY_TURNS = 50;

/** ChatTurn / ProjectChatTurn の最小 shape ガード (load 時の trim/検証に使用)。 */
function isChatTurn(item: unknown): item is ChatTurn {
  return (
    item !== null &&
    typeof item === 'object' &&
    typeof (item as { id?: unknown }).id === 'string' &&
    typeof (item as { userQuery?: unknown }).userQuery === 'string'
  );
}
function isProjectChatTurn(item: unknown): item is ProjectChatTurn {
  return isChatTurn(item);
}

/**
 * パネルのモード (= タブ切替)。
 *
 * - 'search': 既存の過去資産意味検索 (Voyage AI で pgvector top-K)
 * - 'help' : たすきフクロウ AI ヘルプチャット (ADR-0028 / RAG。FAQ + 使い方ガイド)
 *
 * mode は sessionStorage に保存し、パネル再オープン / リロード後も同じタブを維持する。
 * 値が壊れていたら 'search' に fail-safe (= 既存 UX に倒す)。
 * 'project' タブは projectId が渡されたときのみ表示される。非プロジェクトページで
 * sessionStorage に 'project' が残っていた場合は 'search' に fallback する。
 */
type PanelMode = 'search' | 'help' | 'project';
const PANEL_MODE_STORAGE_KEY = 'tasukiba_chat_panel_mode_v1';

function loadPanelMode(hasProjectId: boolean): PanelMode {
  if (typeof window === 'undefined') return 'search';
  try {
    const raw = window.sessionStorage.getItem(PANEL_MODE_STORAGE_KEY);
    if (raw === 'project') return hasProjectId ? 'project' : 'search';
    if (raw === 'help' || raw === 'search') return raw;
    return 'search';
  } catch {
    return 'search';
  }
}

function savePanelMode(mode: PanelMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(PANEL_MODE_STORAGE_KEY, mode);
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

/**
 * @param projectId プロジェクト詳細ページで渡す。'project' タブの表示制御と API 呼び出しに使用。
 */
export function ChatPanel({ onClose, projectId }: { onClose: () => void; projectId?: string }) {
  const t = useTranslations('chatPanel');
  const hasProjectId = Boolean(projectId);
  // ADR-0028: タブで「全資産から探す」「たすきばを知る」「PJ内から探す」を切替。
  // projectId がない画面では 'project' タブを表示せず、'search' に fallback する。
  const [mode, setMode] = useState<PanelMode>(() => loadPanelMode(hasProjectId));
  const handleSwitchMode = useCallback((next: PanelMode) => {
    setMode(next);
    savePanelMode(next);
  }, []);

  // ADR-0028 PR #471 (2026-05-30): help mode の turns 数と remount key を ChatPanel 側で管理。
  const [helpTurnsCount, setHelpTurnsCount] = useState(0);
  const [helpResetKey, setHelpResetKey] = useState(0);

  // project mode の会話履歴 (PJ内から探す)。
  // プロジェクトごとにスコープキーを分離するため、projectId を storageKey に組み込む。
  const [projectTurns, setProjectTurns] = useState<ProjectChatTurn[]>([]);
  const [projectHydrated, setProjectHydrated] = useState(false);
  const loadedProjectUserRef = useRef<string | null>(null);

  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // H-1: 会話履歴を配列で保持。★ユーザ越境防御★: 履歴はユーザ ID 確定後に
  //   ユーザスコープキーから復元する (固定キーの lazy init を廃止)。viewerUserId が
  //   分かるまでは空配列で待ち、確定時に load 用 effect が他ユーザ分 purge + 復元する。
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  // 履歴を現ユーザ分で復元済かを表す。復元前の保存 (= 空配列の clobber) を防ぐゲート。
  const [hydrated, setHydrated] = useState(false);
  // 直近に履歴を復元したユーザ ID。A→B でこの値と viewerUserId が食い違ったら再 load。
  const loadedUserRef = useRef<string | null>(null);
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

  // H-1 (load + ★severity-1 ユーザ越境防御 root fix, 2026-05-31):
  //   viewerUserId が確定 (または A→B で変化) したら、まず他ユーザ分の履歴
  //   (旧固定キー含む) を purge し、現ユーザのスコープキーから復元する。
  //   login/logout は window.location.href のフルページ遷移で effect が発火しないため、
  //   「キーをユーザ ID でスコープ + login 時 purge」という構造で越境を断つ
  //   ([[feedback_client_sessionstorage_user_isolation]])。
  useEffect(() => {
    if (!viewerUserId) return;
    if (loadedUserRef.current === viewerUserId) return;
    loadedUserRef.current = viewerUserId;
    purgeOtherUsersHistory(CHAT_SEARCH_HISTORY_BASE_KEY, viewerUserId);
    setTurns(loadScopedHistory(CHAT_SEARCH_HISTORY_BASE_KEY, viewerUserId, isChatTurn, MAX_HISTORY_TURNS));
    setHydrated(true);
  }, [viewerUserId]);

  // H-1 (persist): turns が変わるたびに現ユーザのスコープキーへ書き戻す。
  //   復元前 (hydrated=false) は空配列の clobber を避けるため skip。
  //   ログアウト中 (isUnauthenticated) も復活防止のため skip。
  useEffect(() => {
    if (!hydrated || !viewerUserId || isUnauthenticated) return;
    saveScopedHistory(CHAT_SEARCH_HISTORY_BASE_KEY, viewerUserId, turns, MAX_HISTORY_TURNS);
  }, [turns, hydrated, viewerUserId, isUnauthenticated]);

  // H-2: ログアウト遷移を検知したら全ユーザ分の履歴を purge + state クリア。
  //   現ユーザを特定できない (viewerUserId=undefined) ため全 baseKey を一掃する。
  //   Cookie 削除に依存せず client-side で確実に消す ([feedback_session_clearance_pattern] 思想)。
  //   ※ 主防御はキースコープ + login 時 purge。本 effect はフルページ遷移が起きない
  //     SPA 内サインアウト経路向けの多層防御。
  useEffect(() => {
    if (!isUnauthenticated) return;
    purgeAllHistory(CHAT_SEARCH_HISTORY_BASE_KEY);
    purgeAllHistory(PROJECT_SEARCH_HISTORY_BASE_KEY);
    loadedUserRef.current = null;
    loadedProjectUserRef.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTurns([]);
    setProjectTurns([]);
    setHydrated(false);
    setProjectHydrated(false);
  }, [isUnauthenticated]);

  // PJ内から探すの履歴を viewerUserId + projectId スコープで load する。
  // projectId が変わる (= 別プロジェクトに移動) ときも再 load される。
  const projectStorageKey = projectId
    ? `${PROJECT_SEARCH_HISTORY_BASE_KEY}_p_${projectId}`
    : null;
  useEffect(() => {
    if (!viewerUserId || !projectStorageKey) return;
    const compositeKey = `${viewerUserId}:${projectStorageKey}`;
    if (loadedProjectUserRef.current === compositeKey) return;
    loadedProjectUserRef.current = compositeKey;
    setProjectTurns(
      loadScopedHistory(projectStorageKey, viewerUserId, isProjectChatTurn, MAX_HISTORY_TURNS),
    );
    setProjectHydrated(true);
  }, [viewerUserId, projectStorageKey]);

  useEffect(() => {
    if (!projectHydrated || !viewerUserId || !projectStorageKey || isUnauthenticated) return;
    saveScopedHistory(projectStorageKey, viewerUserId, projectTurns, MAX_HISTORY_TURNS);
  }, [projectTurns, projectHydrated, viewerUserId, projectStorageKey, isUnauthenticated]);

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
        const message = body.error?.message ?? t('searchErrorWithStatus', { status: res.status });
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
      const message = e instanceof Error ? e.message : t('searchErrorDefault');
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

  // PJ内から探す 専用の submit ハンドラ。
  const [projectSubmitting, setProjectSubmitting] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const projectInFlightAbortRef = useRef<AbortController | null>(null);

  const handleProjectSubmit = useCallback(async () => {
    if (projectSubmitting || projectQuery.trim().length === 0 || !projectId) return;

    projectInFlightAbortRef.current?.abort();
    const ac = new AbortController();
    projectInFlightAbortRef.current = ac;

    const turnId = generateTurnId();
    const submittedQuery = projectQuery;

    setProjectSubmitting(true);
    setProjectTurns((prev) => [...prev, { id: turnId, userQuery: submittedQuery }]);
    setProjectQuery('');

    try {
      const res = await fetch(`/api/projects/${projectId}/chat/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: submittedQuery }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        const message = body.error?.message ?? t('searchErrorWithStatus', { status: res.status });
        setProjectTurns((prev) =>
          prev.map((turn) => (turn.id === turnId ? { ...turn, error: message } : turn)),
        );
      } else {
        const body = (await res.json()) as { data: ProjectChatSearchResult };
        setProjectTurns((prev) =>
          prev.map((turn) => (turn.id === turnId ? { ...turn, result: body.data } : turn)),
        );
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      const message = e instanceof Error ? e.message : t('searchErrorDefault');
      setProjectTurns((prev) =>
        prev.map((turn) => (turn.id === turnId ? { ...turn, error: message } : turn)),
      );
    } finally {
      if (projectInFlightAbortRef.current === ac) {
        setProjectSubmitting(false);
        projectInFlightAbortRef.current = null;
      }
    }
  }, [projectQuery, projectSubmitting, projectId]);

  // 履歴クリア (手動)。ユーザが明示的に「過去の会話を消したい」と意思表示した場合に呼ばれる。
  // ADR-0028 PR #471: ChatPanel ヘッダの統一クリアボタンから全 mode をクリアできるよう
  //   現 mode に応じて対象履歴を切替 (UI の見た目は完全一致)。
  const handleClearHistory = useCallback(() => {
    // ユーザスコープキーから現ユーザ分のみ削除する (越境防御と同じキー体系)。
    if (!viewerUserId) return;
    if (mode === 'search') {
      clearScopedHistory(CHAT_SEARCH_HISTORY_BASE_KEY, viewerUserId);
      setTurns([]);
    } else if (mode === 'project') {
      if (projectStorageKey) clearScopedHistory(projectStorageKey, viewerUserId);
      setProjectTurns([]);
    } else {
      // help mode: HelpChatInput が管理する help チャットのスコープキーを直接削除 +
      //   remount (helpResetKey) で内部 state を破棄。
      clearScopedHistory(HELP_CHAT_HISTORY_BASE_KEY, viewerUserId);
      setHelpResetKey((k) => k + 1);
      setHelpTurnsCount(0);
    }
  }, [mode, viewerUserId, projectStorageKey]);

  return (
    <aside
      role="complementary"
      aria-label={t('ariaLabelPanel')}
      className="fixed inset-y-0 right-0 z-40 flex h-full w-full max-w-md flex-col border-l border-border bg-background shadow-xl"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        {/*
          2026-05-27 デザイン更新: 「ユーザは誰と会話しているか」を明示するため、
          ヘッダにアシスタント・ペルソナ (たすきフクロウ) のアバターと表示名を提示。
          ADR-0028 (2026-05-30): サブタイトルは mode で切替 (検索 / ヘルプ)。
        */}
        <div className="flex items-center gap-2">
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
              {mode === 'search'
                ? t('subtitleSearch')
                : mode === 'project'
                  ? t('subtitleProject')
                  : t('subtitleHelp')}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {/*
            ADR-0028 PR #471 (2026-05-30): 統一ヘッダのクリアボタンは mode 共通で常に表示。
            UI の見た目を search / help タブで完全に揃える ([feedback_sibling_ui_pattern_horizontal_rollout]:
            同じ機能を有する UI は完全一致が原則 = ゴミ箱位置も含めて統一)。
            disabled 判定は現 mode の turns 数に基づく。
          */}
          {/*
            ADR-0028 PR #471 2 巡目検証 (2026-05-30): aria-label / title を mode 別に動的化。
            screen reader ユーザに「今クリックするとどちらの履歴がクリアされるか」を明示する
            (a11y、両モードで「会話履歴をクリア」固定だと判別不能)。
          */}
          <button
            type="button"
            onClick={handleClearHistory}
            disabled={
              mode === 'search'
                ? turns.length === 0
                : mode === 'project'
                  ? projectTurns.length === 0
                  : helpTurnsCount === 0
            }
            aria-label={
              mode === 'search'
                ? t('ariaLabelClearSearch')
                : mode === 'project'
                  ? t('ariaLabelClearProject')
                  : t('ariaLabelClearHelp')
            }
            title={
              mode === 'search'
                ? t('ariaLabelClearSearch')
                : mode === 'project'
                  ? t('ariaLabelClearProject')
                  : t('ariaLabelClearHelp')
            }
            data-testid="chat-panel-clear-history"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          >
            🗑️
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('ariaLabelClose')}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            ✕
          </button>
        </div>
      </header>

      {/*
        ADR-0028: WAI-ARIA tab pattern. role="tablist" + role="tab" + aria-selected /
        aria-controls + role="tabpanel" + aria-labelledby で MDN/W3C 標準形に準拠。
        左→右の順で頻度の高い既存機能 (search) を先頭に置く。
      */}
      <div
        role="tablist"
        aria-label={t('tablistAriaLabel')}
        className="flex border-b border-border bg-muted/30"
      >
        <button
          type="button"
          role="tab"
          id="chat-panel-tab-search"
          aria-selected={mode === 'search'}
          aria-controls="chat-panel-panel-search"
          tabIndex={mode === 'search' ? 0 : -1}
          onClick={() => handleSwitchMode('search')}
          data-testid="chat-panel-tab-search"
          className={cn(
            'flex-1 px-3 py-2 text-xs font-medium border-b-2 transition-colors',
            mode === 'search'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {t('tabSearch')}
        </button>
        <button
          type="button"
          role="tab"
          id="chat-panel-tab-help"
          aria-selected={mode === 'help'}
          aria-controls="chat-panel-panel-help"
          tabIndex={mode === 'help' ? 0 : -1}
          onClick={() => handleSwitchMode('help')}
          data-testid="chat-panel-tab-help"
          className={cn(
            'flex-1 px-3 py-2 text-xs font-medium border-b-2 transition-colors',
            mode === 'help'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {t('tabHelp')}
        </button>
        {/* PJ内から探すタブ: projectId がある (= プロジェクト詳細画面) ときのみ表示 */}
        {hasProjectId && (
          <button
            type="button"
            role="tab"
            id="chat-panel-tab-project"
            aria-selected={mode === 'project'}
            aria-controls="chat-panel-panel-project"
            tabIndex={mode === 'project' ? 0 : -1}
            onClick={() => handleSwitchMode('project')}
            data-testid="chat-panel-tab-project"
            className={cn(
              'flex-1 px-3 py-2 text-xs font-medium border-b-2 transition-colors',
              mode === 'project'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t('tabProject')}
          </button>
        )}
      </div>

      {/*
        ADR-0028 PR #471 2 巡目検証 (2026-05-30): タブ切替で state 消失を防ぐため、
        条件レンダリングではなく **両 tabpanel を常に mount しつつ hidden 属性で表示制御** する。
        WAI-ARIA tab pattern の標準形 (= 非アクティブ側もメモリ常駐) に準拠。
        これにより search → help → search の切替で「入力中クエリ / in-flight fetch / scroll 位置」
        が保持される。両 sessionStorage が初期 load 時に同時に読まれるが、軽量なため性能影響なし。
      */}
      <div
        role="tabpanel"
        id="chat-panel-panel-search"
        aria-labelledby="chat-panel-tab-search"
        hidden={mode !== 'search'}
        className={mode === 'search' ? 'flex flex-1 min-h-0 flex-col' : ''}
      >
        {mode === 'search' && (
          <SearchModeBody
            turns={turns}
            query={query}
            setQuery={setQuery}
            submitting={submitting}
            showWarning={showWarning}
            tooLong={tooLong}
            handleSubmit={handleSubmit}
            handleKeyDown={handleKeyDown}
            handleCardClick={handleCardClick}
            viewerUserId={viewerUserId}
            sessionLoading={sessionLoading}
            bottomAnchorRef={bottomAnchorRef}
            isNavigating={isNavigating}
          />
        )}
      </div>
      <div
        role="tabpanel"
        id="chat-panel-panel-help"
        aria-labelledby="chat-panel-tab-help"
        hidden={mode !== 'help'}
        className={mode === 'help' ? 'flex flex-1 min-h-0 flex-col' : ''}
      >
        {/*
          HelpChatInput は **常に mount**:
            - hideHeader: ChatPanel ヘッダ (アバター + persona + クリア + 閉じる) に一元化
            - onTurnsCountChange: ChatPanel 側でクリアボタン disabled 判定に使う
            - key={helpResetKey}: クリア時に意図的 re-mount で内部 state 破棄 (タブ切替では re-mount しない)
          ★非アクティブ時 (mode='search') も内部 state は維持される (= 入力中クエリ / in-flight fetch 保持)。
        */}
        <HelpChatInput
          key={helpResetKey}
          variant="panel"
          hideHeader
          onTurnsCountChange={setHelpTurnsCount}
        />
      </div>
      {/* PJ内から探すタブパネル: projectId があるときのみ mount */}
      {hasProjectId && (
        <div
          role="tabpanel"
          id="chat-panel-panel-project"
          aria-labelledby="chat-panel-tab-project"
          hidden={mode !== 'project'}
          className={mode === 'project' ? 'flex flex-1 min-h-0 flex-col' : ''}
        >
          {mode === 'project' && projectId && (
            <ProjectSearchModeBody
              projectId={projectId}
              turns={projectTurns}
              query={projectQuery}
              setQuery={setProjectQuery}
              submitting={projectSubmitting}
              handleSubmit={handleProjectSubmit}
              handleCardClick={handleCardClick}
              bottomAnchorRef={bottomAnchorRef}
              isNavigating={isNavigating}
            />
          )}
        </div>
      )}
    </aside>
  );
}

/**
 * 検索モードの本体 (Voyage 告知 + メッセージ領域 + 送信欄)。
 * mode='help' との conditional render を分かりやすくするため、別 component に切り出した。
 */
function SearchModeBody({
  turns,
  query,
  setQuery,
  submitting,
  showWarning,
  tooLong,
  handleSubmit,
  handleKeyDown,
  handleCardClick,
  viewerUserId,
  sessionLoading,
  bottomAnchorRef,
  isNavigating,
}: {
  turns: ChatTurn[];
  query: string;
  setQuery: (q: string) => void;
  submitting: boolean;
  showWarning: boolean;
  tooLong: boolean;
  handleSubmit: () => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  handleCardClick: () => void;
  viewerUserId: string | undefined;
  sessionLoading: boolean;
  bottomAnchorRef: React.RefObject<HTMLDivElement | null>;
  isNavigating: boolean;
}) {
  const t = useTranslations('chatPanel');
  return (
    <div
      role="tabpanel"
      id="chat-panel-panel-search"
      aria-labelledby="chat-panel-tab-search"
      className="flex flex-1 min-h-0 flex-col"
    >
      {/*
        Voyage への外部送信を明示告知 (about.md §Q5 と整合)。
      */}
      <div className="border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
        {t('voyageNotice')}
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
              {t('greetingHello', { name: CHAT_PERSONA.name })}
            </p>
            <p className="mt-1 leading-relaxed">
              {t('greetingBody')}
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
            {t('navigationPending')}
          </div>
        )}

        {/* 自動スクロールアンカー */}
        <div ref={bottomAnchorRef} />
      </div>

      <footer className="border-t border-border p-3">
        {showWarning && (
          <div className="mb-2 text-xs text-warning-foreground">
            {t('warningShortQuery')}
          </div>
        )}
        {tooLong && (
          <div className="mb-2 text-xs text-destructive">
            {t('warningTooLong', { max: CHAT_SEARCH_INPUT_MAX_CHARS })}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={submitting}
            placeholder={t('inputPlaceholder')}
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
            aria-label={t('ariaLabelSend')}
            className={cn(
              'h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground',
              'hover:bg-primary/80 disabled:opacity-50 disabled:hover:bg-primary',
            )}
          >
            {submitting ? t('btnSearching') : t('btnSend')}
          </button>
        </div>
      </footer>
    </div>
  );
}

/**
 * 「PJ内から探す」モードの本体。SearchModeBody と同構造だが ProjectChatSearchResult を使う。
 */
function ProjectSearchModeBody({
  projectId,
  turns,
  query,
  setQuery,
  submitting,
  handleSubmit,
  handleCardClick,
  bottomAnchorRef,
  isNavigating,
}: {
  projectId: string;
  turns: ProjectChatTurn[];
  query: string;
  setQuery: (q: string) => void;
  submitting: boolean;
  handleSubmit: () => void;
  handleCardClick: () => void;
  bottomAnchorRef: React.RefObject<HTMLDivElement | null>;
  isNavigating: boolean;
}) {
  const t = useTranslations('chatPanel');
  const tooLong = query.length > CHAT_SEARCH_INPUT_MAX_CHARS;
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
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
        {t('voyageNotice')}
      </div>
      <div className="flex-1 overflow-y-auto p-4 text-sm" data-testid="chat-panel-project-messages">
        <AssistantBubble>
          <div data-testid="chat-project-initial-greeting">
            <p className="leading-relaxed">
              {t('greetingProjectHello', { name: CHAT_PERSONA.name })}
            </p>
            <p className="mt-1 leading-relaxed">{t('greetingProjectBody')}</p>
          </div>
        </AssistantBubble>

        {turns.map((turn) => (
          <ProjectChatTurnView
            key={turn.id}
            turn={turn}
            projectId={projectId}
            onCardClick={handleCardClick}
          />
        ))}

        {isNavigating && (
          <div
            role="status"
            aria-live="polite"
            className="mb-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
          >
            {t('navigationPending')}
          </div>
        )}
        <div ref={bottomAnchorRef} />
      </div>

      <footer className="border-t border-border p-3">
        {tooLong && (
          <div className="mb-2 text-xs text-destructive">
            {t('warningTooLong', { max: CHAT_SEARCH_INPUT_MAX_CHARS })}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={submitting}
            placeholder={t('inputPlaceholder')}
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
            aria-label={t('ariaLabelSend')}
            className={cn(
              'h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground',
              'hover:bg-primary/80 disabled:opacity-50 disabled:hover:bg-primary',
            )}
          >
            {submitting ? t('btnSearching') : t('btnSend')}
          </button>
        </div>
      </footer>
    </div>
  );
}

function ProjectChatTurnView({
  turn,
  projectId,
  onCardClick,
}: {
  turn: ProjectChatTurn;
  projectId: string;
  onCardClick: () => void;
}) {
  const t = useTranslations('chatPanel');
  const [strongExpanded, setStrongExpanded] = useState(false);
  const [mediumExpanded, setMediumExpanded] = useState(false);
  const [weakExpanded, setWeakExpanded] = useState(false);
  const pending = !turn.result && !turn.error;

  return (
    <>
      <UserBubble text={turn.userQuery} />
      {turn.error ? (
        <div
          role="alert"
          className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {turn.error}
        </div>
      ) : pending ? (
        <AssistantBubble>
          <div className="text-xs text-muted-foreground" role="status" aria-live="polite">
            {t('pendingProjectMessage')}
          </div>
        </AssistantBubble>
      ) : turn.result ? (
        <AssistantBubble>
          {turn.result.degraded && (
            <div className="mb-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
              {t('degradedNotice', { label: turn.result.degradeReason ?? '' })}
            </div>
          )}
          <ProjectChatResults
            result={turn.result}
            projectId={projectId}
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

function ProjectChatResults({
  result,
  projectId,
  strongExpanded,
  mediumExpanded,
  weakExpanded,
  onToggleStrong,
  onToggleMedium,
  onToggleWeak,
  onCardClick,
}: {
  result: ProjectChatSearchResult;
  projectId: string;
  strongExpanded: boolean;
  mediumExpanded: boolean;
  weakExpanded: boolean;
  onToggleStrong: () => void;
  onToggleMedium: () => void;
  onToggleWeak: () => void;
  onCardClick: () => void;
}) {
  const t = useTranslations('chatPanel');
  const allHits = [
    ...result.results.knowledges,
    ...result.results.risksIssues,
    ...result.results.retrospectives,
    ...result.results.qaThreads,
    ...result.results.whiteboardSessions,
    ...result.results.votingSessions,
  ];

  if (allHits.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/50 px-3 py-4 text-center text-xs text-muted-foreground">
        {t('noResults')}
      </div>
    );
  }

  const strong = allHits.filter((h) => h.tier === 'strong').sort((a, b) => b.score - a.score);
  const medium = allHits.filter((h) => h.tier === 'medium').sort((a, b) => b.score - a.score);
  const weak = allHits.filter((h) => h.tier === 'weak').sort((a, b) => b.score - a.score);
  const strongInitial = strong.slice(0, SUGGESTION_TIER_STRONG_INITIAL_VISIBLE);
  const strongRest = strong.slice(SUGGESTION_TIER_STRONG_INITIAL_VISIBLE);

  return (
    <div>
      <div className="mb-3 text-xs text-muted-foreground">
        {t('foundCount', { count: result.totalCount, scope: t('scopeAssets') })}
      </div>

      {strong.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-2 text-xs font-semibold text-foreground">
            {t('strongSectionTitle', { count: strong.length })}
          </h3>
          <div className="flex flex-col gap-2">
            {strongInitial.map((hit) => (
              <ProjectChatSearchResultCard
                key={`${hit.kind}-${hit.id}`}
                hit={hit}
                projectId={projectId}
                onClick={onCardClick}
              />
            ))}
            {strongRest.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={onToggleStrong}
                  aria-expanded={strongExpanded}
                  className="mt-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  {strongExpanded
                    ? t('strongShowLess', { count: strongRest.length })
                    : t('strongShowMore', { count: strongRest.length })}
                </button>
                {strongExpanded &&
                  strongRest.map((hit) => (
                    <ProjectChatSearchResultCard
                      key={`${hit.kind}-${hit.id}`}
                      hit={hit}
                      projectId={projectId}
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
          <button
            type="button"
            onClick={onToggleMedium}
            aria-expanded={mediumExpanded}
            className="mb-2 text-xs font-semibold text-foreground hover:text-muted-foreground"
          >
            {mediumExpanded ? t('mediumExpandedLabel', { count: medium.length }) : t('mediumCollapsed', { count: medium.length })}
          </button>
          {mediumExpanded && (
            <div className="flex flex-col gap-2">
              {medium.map((hit) => (
                <ProjectChatSearchResultCard
                  key={`${hit.kind}-${hit.id}`}
                  hit={hit}
                  projectId={projectId}
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
            className="mb-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
          >
            {weakExpanded ? t('weakExpandedLabel', { count: weak.length }) : t('weakCollapsed', { count: weak.length })}
          </button>
          {weakExpanded && (
            <div className="flex flex-col gap-2">
              {weak.map((hit) => (
                <ProjectChatSearchResultCard
                  key={`${hit.kind}-${hit.id}`}
                  hit={hit}
                  projectId={projectId}
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
  const t = useTranslations('chatPanel');
  const degradedLabelMap: Record<DegradedReason, string> = {
    rate_limited: t('degradedRateLimit'),
    beginner_limit_exceeded: t('degradedBeginnerLimit'),
    budget_exceeded: t('degradedBudget'),
    fair_use_limit_exceeded: t('degradedFairUse'),
    embedding_budget_exceeded: t('degradedEmbeddingBudget'),
    embedding_beginner_limit_exceeded: t('degradedEmbeddingBeginner'),
    tenant_inactive: t('degradedTenantInactive'),
    plan_invalid: t('degradedPlanInvalid'),
    llm_error: t('degradedLlmError'),
    output_invalid: t('degradedOutputInvalid'),
  };
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
            {t('pendingMessage')}
          </div>
        </AssistantBubble>
      ) : turn.result ? (
        <AssistantBubble>
          {turn.result.degraded && turn.result.degradeReason && (
            <div className="mb-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
              {t('degradedNotice', { label: degradedLabelMap[turn.result.degradeReason] ?? turn.result.degradeReason })}
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
  const t = useTranslations('chatPanel');
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
        {t('noResults')}
        {result.fileScopeApplied && (
          <div className="mt-1 text-xs">
            {t('fileScopeNote')}
          </div>
        )}
      </div>
    );
  }

  // tier 別にグルーピング (全 5 資産横断でソート)
  const strong = allHits.filter((h) => h.tier === 'strong').sort((a, b) => b.score - a.score);
  const medium = allHits.filter((h) => h.tier === 'medium').sort((a, b) => b.score - a.score);
  const weak = allHits.filter((h) => h.tier === 'weak').sort((a, b) => b.score - a.score);

  // H-3: strong tier の表示分割。初期は上位 SUGGESTION_TIER_STRONG_INITIAL_VISIBLE 件、それ以降は折りたたみ。
  const strongInitial = strong.slice(0, SUGGESTION_TIER_STRONG_INITIAL_VISIBLE);
  const strongRest = strong.slice(SUGGESTION_TIER_STRONG_INITIAL_VISIBLE);

  // C-4: session 読み込み中は memo リンクを disable する判定関数。
  const isCardDisabled = (hit: ChatSearchHit): boolean =>
    sessionLoading && hit.kind === 'memo';

  return (
    <div>
      {result.fileScopeApplied && (
        <div className="mb-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
          {t('fileScopeAppliedNotice')}
        </div>
      )}
      <div className="mb-3 text-xs text-muted-foreground">
        {t('foundCount', { count: result.totalCount, scope: result.fileScopeApplied ? t('scopeAttachments') : t('scopeAssets') })}
      </div>

      {strong.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-2 text-xs font-semibold text-foreground">
            {t('strongSectionTitle', { count: strong.length })}
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
                    ? t('strongShowLess', { count: strongRest.length })
                    : t('strongShowMore', { count: strongRest.length })}
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
            {mediumExpanded ? t('mediumExpandedLabel', { count: medium.length }) : t('mediumCollapsed', { count: medium.length })}
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
            {weakExpanded ? t('weakExpandedLabel', { count: weak.length }) : t('weakCollapsed', { count: weak.length })}
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
