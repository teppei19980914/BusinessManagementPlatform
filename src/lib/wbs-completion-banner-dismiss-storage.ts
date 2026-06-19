/**
 * WBS 完了バナー (v1.3.0 資産導線機能) の「×で閉じた」状態の sessionStorage 永続化。
 *
 * [[banner-dismiss-storage]] (システム周知バナー) と同型の設計をプロジェクト単位に適用したもの:
 *   - 破棄済み projectId 集合を **userId でスコープしたキー** に保存する
 *     (ユーザ切替時に他ユーザの破棄状態を継承しないため)。
 *   - ログアウト (useSession status='unauthenticated') 遷移時に purge する
 *     (再ログイン後、当該プロジェクトを再訪すれば再表示させるため)。
 *
 * 値はプロジェクト id の配列 (JSON)。複数プロジェクトを同時に閲覧しうるため集合で持つ。
 */

const BASE_KEY = 'tasukiba_dismissed_wbs_completion_banner_v1'; // gitleaks:allow

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

/** 指定ユーザが当該プロジェクトの WBS 完了バナーを既に×で閉じているか。 */
export function isWbsCompletionBannerDismissed(userId: string, projectId: string): boolean {
  return readIds(userId).includes(projectId);
}

/** 指定ユーザの破棄済み集合に projectId を追加する。 */
export function dismissWbsCompletionBanner(userId: string, projectId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const ids = readIds(userId);
    if (ids.includes(projectId)) return;
    ids.push(projectId);
    window.sessionStorage.setItem(scopedKey(userId), JSON.stringify(ids));
  } catch {
    // quota / private mode 等は無視 (帯がそのセッションで再表示されるだけで実害なし)
  }
}

/**
 * 破棄状態を全ユーザ分削除する。ログアウト時 (現在ユーザを特定できない) に呼ぶことで、
 * 再ログイン後に再表示される。
 */
export function purgeAllWbsCompletionBannerDismiss(): void {
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
