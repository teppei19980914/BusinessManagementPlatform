/**
 * ログイン画面の「過去ログインしたテナント」localStorage 記憶ユーティリティ (PR #420 補足対応)。
 *
 * 役割:
 *   毎回手で組織 ID を入力する負担を減らすため、直近ログイン成功したテナントを
 *   ブラウザの localStorage に LRU で 5 件保持し、login 画面で datalist にする。
 *
 * セキュリティ設計 (最重要):
 *   - **email / password / token / tenantId(UUID) は保存しない**。slug + name + lastUsedAt のみ。
 *   - **pre-auth で server に slug→name 問合せをしない**。tenant name は post-auth (login 成功直後)
 *     の `/api/me/tenant-info` 認証付きエンドポイントから取得する。
 *   - 読込時に shape / 型 / 文字列長 / slug パターンを **全件検証** し、不正データは破棄する
 *     (XSS で書込まれた壊れたデータを信用しない)。
 *   - エントリは **90 日経過で自動削除** (古い履歴の存在期間を制限)。
 *   - **SSR / build 時 (window 不在) は no-op** で安全に動作する。
 *
 * 関連:
 *   - src/app/(auth)/login/page.tsx (利用元)
 *   - src/app/api/me/tenant-info/route.ts (name 取得経路)
 */

export type TenantHistoryEntry = {
  /** Tenant slug (URL 公開情報、保存可) */
  slug: string;
  /** Tenant 表示名 (login 画面で既に表示される公開情報、保存可) */
  name: string;
  /** ISO8601 timestamp of last successful login (LRU 並び替え + 期限切れ判定用) */
  lastUsedAt: string;
};

const STORAGE_KEY = 'tasukiba.tenantHistory.v1';
const MAX_ENTRIES = 5;
const MAX_AGE_DAYS = 90;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/; // lowercase + digits + hyphens, 1-63 chars
const MAX_NAME_LENGTH = 100;

/**
 * localStorage が利用可能かを安全に判定する。
 * SSR / Edge runtime / Node 環境では window 不在で false。
 */
function canUseStorage(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  } catch {
    return false;
  }
}

/**
 * 1 エントリの型 / 値域を検証する。失敗時 null。
 *
 * 検証項目:
 *   - object 型であること
 *   - slug が string + SLUG_PATTERN 一致
 *   - name が string + 1-MAX_NAME_LENGTH 文字
 *   - lastUsedAt が string + ISO8601 として parse 可能 + MAX_AGE_DAYS 以内
 */
function validateEntry(raw: unknown): TenantHistoryEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<TenantHistoryEntry>;

  if (typeof r.slug !== 'string' || !SLUG_PATTERN.test(r.slug)) return null;
  if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > MAX_NAME_LENGTH) {
    return null;
  }
  if (typeof r.lastUsedAt !== 'string') return null;

  const ms = Date.parse(r.lastUsedAt);
  if (Number.isNaN(ms)) return null;

  // 90 日経過で expire
  const ageMs = Date.now() - ms;
  if (ageMs > MAX_AGE_DAYS * 24 * 60 * 60 * 1000) return null;
  // 未来日時 (時計巻き戻し / 改竄) は無効
  if (ageMs < -60 * 1000) return null;

  return { slug: r.slug, name: r.name, lastUsedAt: r.lastUsedAt };
}

/**
 * localStorage から履歴を取得する。検証を通らないエントリは捨てる。
 * 副作用: 不正データを発見した場合、localStorage を浄化して書き戻す。
 */
export function getTenantHistory(): TenantHistoryEntry[] {
  if (!canUseStorage()) return [];

  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 壊れた JSON は破棄
    safeRemove();
    return [];
  }

  if (!Array.isArray(parsed)) {
    safeRemove();
    return [];
  }

  const valid = parsed
    .map(validateEntry)
    .filter((e): e is TenantHistoryEntry => e !== null)
    .slice(0, MAX_ENTRIES);

  // 不正データ発見時は浄化して書き戻す
  if (valid.length !== parsed.length) {
    safeWrite(valid);
  }

  return valid;
}

/**
 * ログイン成功時に呼ぶ: (slug, name) を履歴に LRU で追加。
 * 同じ slug が既にあれば lastUsedAt を更新して先頭に移動。
 *
 * 不正な slug / name は無視 (= no-op)。
 */
export function recordTenantUsage(slug: string, name: string): void {
  if (!canUseStorage()) return;
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) return;
  if (typeof name !== 'string' || name.length === 0) return;

  // name は MAX_NAME_LENGTH まで truncate (defense: 異常に長い name を弾く)
  const safeName = name.slice(0, MAX_NAME_LENGTH);
  const now = new Date().toISOString();

  const existing = getTenantHistory();
  const filtered = existing.filter((e) => e.slug !== slug);
  const next: TenantHistoryEntry[] = [{ slug, name: safeName, lastUsedAt: now }, ...filtered].slice(
    0,
    MAX_ENTRIES,
  );

  safeWrite(next);
}

/**
 * 個別エントリを削除 (UI から「× 削除」を提供する用途)。
 */
export function removeTenantFromHistory(slug: string): void {
  if (!canUseStorage()) return;
  const next = getTenantHistory().filter((e) => e.slug !== slug);
  safeWrite(next);
}

/**
 * 履歴を全消去 (login 画面の「履歴をクリア」リンク用)。
 */
export function clearTenantHistory(): void {
  if (!canUseStorage()) return;
  safeRemove();
}

// ============================================================
// 内部 helper
// ============================================================

function safeWrite(entries: TenantHistoryEntry[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // QuotaExceededError 等は黙殺 (履歴は best-effort)
  }
}

function safeRemove(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}
