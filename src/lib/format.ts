/**
 * 表示用フォーマッタユーティリティ (PR #63 / PR #117 ハイドレーション対応)。
 *
 * DRY 原則 (DESIGN.md 21.2): 複数画面で重複していた書式整形ロジックを集約する。
 *
 * PR #117 (2026-04-24) 改修: **全て Asia/Tokyo 固定タイムゾーンで描画** する。
 *   旧実装は `d.getFullYear()` / `d.toLocaleDateString('ja-JP')` 等で **runtime の TZ** に依存し、
 *   Server Component SSR (UTC) とクライアント Hydration (JST) で描画結果が異なり
 *   React error #418 (Minified React error, hydration text mismatch) を誘発していた。
 *
 *   Intl.DateTimeFormat に `timeZone: 'Asia/Tokyo'` を明示することで、
 *   Vercel / ローカル / ブラウザ いずれの runtime でも同じ文字列を返す。
 *   本サービスは日本国内ユーザのみを想定するため JST 固定で支障なし。
 */

const FIXED_TZ = 'Asia/Tokyo';

// PR #117: DateTimeFormat インスタンスはモジュールスコープで使い回す (インスタンス生成コスト回避)
const dateTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: FIXED_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: FIXED_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * ISO 日時文字列を「YYYY-MM-DD HH:MM」JST で整形する。
 *
 * - サーバから受け取る ISO (UTC) を JST で表示する用途。
 * - SSR と Hydration で同じ結果を返すよう `Asia/Tokyo` 固定。
 * - 出力形式は従来の `-` 区切りに揃える (既存 UI 影響回避)。
 */
export function formatDateTime(iso: string): string {
  const parts = dateTimeFormatter.formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/**
 * ISO 日付/日時文字列を「YYYY/MM/DD」JST で整形する (日付のみ)。
 *
 * PR #117 で新設。旧 `new Date(x).toLocaleDateString('ja-JP')` を置換する用途。
 * Intl が返す区切り文字は locale 依存で `ja-JP` は `/` ベース。
 */
export function formatDate(iso: string): string {
  return dateFormatter.format(new Date(iso));
}

/**
 * ISO 日時文字列を「YYYY/MM/DD HH:MM」JST で整形する (詳細表示用、title/tooltip 等)。
 *
 * PR #117 で新設。旧 `new Date(x).toLocaleString('ja-JP')` を置換する用途。
 */
export function formatDateTimeFull(iso: string): string {
  return dateTimeFormatter.format(new Date(iso));
}
