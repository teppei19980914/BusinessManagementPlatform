/**
 * システム周知バナーの「×で閉じた」状態の sessionStorage 永続化 (ADR-0036)。
 *
 * 要件 (ADR-0036 §5):
 *   - ×で閉じた帯は、確立中のセッション内では再表示しない。
 *   - ログアウト → 再ログイン後は (期間内なら) 再表示する。
 *
 * 設計 ([[feedback_client_sessionstorage_user_isolation]] のユーザ越境防御を踏襲):
 *   - 破棄済み banner id 集合を **userId でスコープしたキー** (`${BASE_KEY}:${userId}`) に保存する。
 *     これにより A→B のユーザ切替で B が A の破棄状態を継承しない。
 *   - ログアウト (useSession status='unauthenticated') 遷移時に purgeAllBannerDismiss() を呼ぶ。
 *     sessionStorage はタブ内のフルページ遷移で生き残るため、明示 purge しないと
 *     「ログアウト→再ログインで再表示」が満たせない (chat-history-storage と同型の理由)。
 *
 * 値はバナー id の配列 (JSON)。1 本制約により同時表示は最大 1 本だが、
 * セッション中に複数の異なるバナーを順次破棄しうるため集合で持つ。
 */

const BASE_KEY = 'tasukiba_dismissed_banner_v1';

function scopedKey(userId: string): string {
  return `${BASE_KEY}:${userId}`;
}

function isDismissKey(key: string): boolean {
  return key === BASE_KEY || key.startsWith(`${BASE_KEY}:`);
}

function readIds(userId: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(scopedKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

/** 指定ユーザが当該バナーを既に×で閉じているか。 */
export function isBannerDismissed(userId: string, bannerId: string): boolean {
  return readIds(userId).includes(bannerId);
}

/** 指定ユーザの破棄済み集合に banner id を追加する。 */
export function dismissBanner(userId: string, bannerId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const ids = readIds(userId);
    if (ids.includes(bannerId)) return;
    ids.push(bannerId);
    window.sessionStorage.setItem(scopedKey(userId), JSON.stringify(ids));
  } catch {
    // quota / private mode 等は無視 (帯がそのセッションで再表示されるだけで実害なし)
  }
}

/**
 * 破棄状態を全ユーザ分削除する。ログアウト時 (現在ユーザを特定できない) に呼ぶことで、
 * 再ログイン後に (期間内なら) 帯が再表示される。
 */
export function purgeAllBannerDismiss(): void {
  if (typeof window === 'undefined') return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i);
      if (key && isDismissKey(key)) toRemove.push(key);
    }
    toRemove.forEach((key) => window.sessionStorage.removeItem(key));
  } catch {
    // noop
  }
}
