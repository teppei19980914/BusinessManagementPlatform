/**
 * チャット会話履歴の sessionStorage 永続化 (★severity-1 ユーザ越境防御★)。
 *
 * fix/chat-history-user-isolation (2026-05-31):
 *   旧実装は固定キー (`tasukiba_chat_history_v1` 等) + React effect ベースの clear
 *   (ログアウト検知 H-2 / ユーザ ID 変化検知 H-5) で越境を防いでいた。
 *   しかし login / logout は `window.location.href` による**フルページ遷移**のため、
 *   'unauthenticated' 状態や viewerUserId の A→B 変化が同一マウント内で描画されず、
 *   effect が一切発火しない。結果、固定キーに残った A の履歴を B が読み出して表示する
 *   越境が発生していた ([[feedback_client_sessionstorage_user_isolation]] /
 *   [[feedback_netlify_nextauth_set_cookie]] の full-navigation 版)。
 *
 *   本ユーティリティは**キー自体をユーザ ID でスコープ** (`${baseKey}:${userId}`) し、
 *   ログイン時に他ユーザ分 (旧固定キー含む) を purge することで、effect の発火に依存せず
 *   「B は構造的に A のキーを参照しない」を保証する (= full-navigation でも安全)。
 *
 *   旧方針 3 点セット ((1)ログアウト clear (2)ユーザ ID 変化検知 (3)件数上限) のうち、
 *   effect 依存だった (1)(2) をキー設計で根本置換し、(3) 件数上限 (maxTurns) は維持する。
 */

/** 過去資産意味検索チャットの履歴 baseKey。 */
export const CHAT_SEARCH_HISTORY_BASE_KEY = 'tasukiba_chat_history_v1';
/** たすきフクロウ ヘルプチャットの履歴 baseKey。 */
export const HELP_CHAT_HISTORY_BASE_KEY = 'tasukiba_help_chat_history_v1';

/** `${baseKey}:${userId}` のユーザスコープ済キーを返す。 */
function scopedKey(baseKey: string, userId: string): string {
  return `${baseKey}:${userId}`;
}

/** あるキーが指定 baseKey の履歴キー (旧固定キー or 任意ユーザのスコープキー) か判定。 */
function isHistoryKey(key: string, baseKey: string): boolean {
  return key === baseKey || key.startsWith(`${baseKey}:`);
}

/**
 * 指定ユーザのスコープ済履歴を読む。SSR safe (window 未定義時は [])。
 * parse 失敗 / shape 不整合 / quota 等の全異常を graceful degradation で吸収。
 * DevTools での大量挿入攻撃を防ぐため、読込時にも maxTurns で trim する (defense-in-depth)。
 */
export function loadScopedHistory<T>(
  baseKey: string,
  userId: string,
  isValidTurn: (item: unknown) => item is T,
  maxTurns: number,
): T[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(scopedKey(baseKey, userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(isValidTurn);
    return valid.length > maxTurns ? valid.slice(-maxTurns) : valid;
  } catch {
    return [];
  }
}

/**
 * 指定ユーザのスコープ済キーへ保存。quota exceeded 等は黙って捨てる (機能継続優先)。
 * maxTurns を超えていたら古いものから捨てて保存する。
 */
export function saveScopedHistory<T>(
  baseKey: string,
  userId: string,
  turns: T[],
  maxTurns: number,
): void {
  if (typeof window === 'undefined') return;
  try {
    const trimmed = turns.length > maxTurns ? turns.slice(-maxTurns) : turns;
    window.sessionStorage.setItem(scopedKey(baseKey, userId), JSON.stringify(trimmed));
  } catch {
    // QuotaExceededError 等。揮発するだけで動作には影響しない。
  }
}

/** 指定ユーザのスコープ済履歴を削除 (手動クリア用)。 */
export function clearScopedHistory(baseKey: string, userId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(scopedKey(baseKey, userId));
  } catch {
    // noop
  }
}

/**
 * 現在ユーザ以外の同 baseKey 履歴 (旧固定キー + 他ユーザのスコープキー) を全削除する。
 * ログイン時 (viewerUserId 確定時) に呼び、A→B の越境残骸を確実に除去する。
 */
export function purgeOtherUsersHistory(baseKey: string, currentUserId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const keep = scopedKey(baseKey, currentUserId);
    const toRemove: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i);
      if (key && isHistoryKey(key, baseKey) && key !== keep) {
        toRemove.push(key);
      }
    }
    toRemove.forEach((key) => window.sessionStorage.removeItem(key));
  } catch {
    // noop
  }
}

/**
 * 同 baseKey の履歴を全ユーザ分削除する。ログアウト時 (現在ユーザを特定できない) に呼ぶ。
 */
export function purgeAllHistory(baseKey: string): void {
  if (typeof window === 'undefined') return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i);
      if (key && isHistoryKey(key, baseKey)) {
        toRemove.push(key);
      }
    }
    toRemove.forEach((key) => window.sessionStorage.removeItem(key));
  } catch {
    // noop
  }
}
