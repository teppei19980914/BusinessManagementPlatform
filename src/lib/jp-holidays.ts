/**
 * 日本の祝日判定ヘルパ (PR #125)。
 *
 * 背景:
 *   Gantt / カレンダー系 UI で土日に加えて日本の祝日 (建国記念日 / こどもの日 / 敬老の日 等) を
 *   視覚的に区別したい。祝日は年ごとに法改正で変動する (2020 年東京五輪の特例移動等) ため、
 *   メンテ済みの外部ライブラリに依存するのが安全。
 *
 * データソース:
 *   `@holiday-jp/holiday_jp` (de facto standard、1970〜2050+ カバー、内閣府公示ベース)
 *
 * API:
 *   - `getJapaneseHoliday(date)`: 祝日名 or null
 *   - `isJapaneseHoliday(date)`: boolean
 *   - `getJapaneseHolidaysBetween(start, end)`: 期間内の祝日一覧
 *
 * 注:
 *   - 引数は `Date` または 'YYYY-MM-DD' 文字列を受理
 *   - タイムゾーンは JST 前提 (src/lib/format.ts と同方針)
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const holiday_jp = require('@holiday-jp/holiday_jp') as {
  isHoliday: (date: string | Date) => boolean;
  between: (start: Date, end: Date) => Array<{
    date: Date | string;
    name: string;
    name_en: string;
    week: string;
    week_en: string;
  }>;
  holidays: Record<
    string,
    {
      date: string;
      name: string;
      name_en: string;
      week: string;
      week_en: string;
    }
  >;
};

/**
 * 'YYYY-MM-DD' 形式に正規化する。
 * Date インスタンスを受けた場合は JST 相当の日付として扱う。
 */
function normalizeDateKey(date: Date | string): string {
  if (typeof date === 'string') {
    // 既に YYYY-MM-DD 形式なら素通し、それ以外は Date を通す
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    date = new Date(date);
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 指定日が日本の祝日なら祝日名を返す。そうでなければ null。
 */
export function getJapaneseHoliday(date: Date | string): string | null {
  const key = normalizeDateKey(date);
  const holiday = holiday_jp.holidays[key];
  return holiday ? holiday.name : null;
}

/**
 * 指定日が日本の祝日かを判定する。
 */
export function isJapaneseHoliday(date: Date | string): boolean {
  return getJapaneseHoliday(date) !== null;
}

/**
 * 期間 [start, end] (両端含む) に含まれる祝日を返す。
 */
export function getJapaneseHolidaysBetween(
  start: Date | string,
  end: Date | string,
): Array<{ date: string; name: string }> {
  const startKey = normalizeDateKey(start);
  const endKey = normalizeDateKey(end);
  const result: Array<{ date: string; name: string }> = [];
  for (const key of Object.keys(holiday_jp.holidays)) {
    if (key >= startKey && key <= endKey) {
      result.push({ date: key, name: holiday_jp.holidays[key].name });
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}
