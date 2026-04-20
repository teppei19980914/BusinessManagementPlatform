/**
 * DateFieldWithActions (PR #72) の純粋関数ヘルパー。
 *
 * .tsx 本体から切り出した理由:
 *   vitest (environment='node') でのユニットテスト対象にしたい。
 *   React コンポーネントを含む .tsx はテスト不能ではないが、
 *   ロジックだけを切り出すほうが依存が明確で可読性が高い。
 */

/** 日付 (YYYY-MM-DD) を今日の文字列で返す。タイムゾーン差異を避けるためローカル時刻を使用。 */
export function todayString(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 'YYYY-MM-DD' 形式の文字列を { y, m, d } (m は 1-12) に分解。不正値は null。 */
export function parseYMD(s: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

/** 年月日から 'YYYY-MM-DD' 文字列を組み立てる (ゼロパディング込み)。 */
export function formatYMD(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 指定月 (y, m) の日付グリッドを 7 日 × 最大 6 週で返す。
 * 前月末 / 翌月頭の「余白日」は null を入れて、1日の列位置を合わせる。
 * 日曜始まり (getDay() 0=日)。
 */
export function buildMonthGrid(y: number, m: number): (number | null)[][] {
  const firstDay = new Date(y, m - 1, 1);
  const lastDay = new Date(y, m, 0);
  const startCol = firstDay.getDay(); // 0=日
  const totalDays = lastDay.getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startCol; i++) cells.push(null);
  for (let d = 1; d <= totalDays; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const rows: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}
