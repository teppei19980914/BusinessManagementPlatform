/**
 * 表示用フォーマッタユーティリティ (PR #63)。
 *
 * DRY 原則 (DESIGN.md 21.2): 複数画面で重複していた書式整形ロジックを集約する。
 * 同じ意味のフォーマットを常に同じコードで扱い、画面ごとの微妙なズレを防ぐ。
 */

/**
 * ISO 日時文字列を「YYYY-MM-DD HH:MM」(ローカルタイム) に整形する。
 *
 * - サーバから受け取る ISO (UTC) 文字列をブラウザのローカル時刻で表示する用途。
 * - 旧実装は knowledge-client / all-risks-table / all-retrospectives-table で
 *   全く同じ実装が 3 回書かれていたため共通化した。
 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}
