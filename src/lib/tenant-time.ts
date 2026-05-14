/**
 * テナント TZ ベースの日付計算ヘルパ (PR-4 / 2026-05-15)
 *
 * 役割:
 *   Tenant.timezone (IANA 名、default 'Asia/Tokyo') を基準に
 *   「カレンダー日」「月初」「経過日数」「翌月初」を計算する純関数群を提供する。
 *
 * 設計判断:
 *   - **Intl.DateTimeFormat の formatToParts を使う**: 外部ライブラリ (luxon / date-fns-tz) を
 *     導入せず Node 標準で TZ 計算を実装。formatToParts(date) はテナント TZ ローカルの
 *     year/month/day/hour 等を文字列として正確に返すため、これを使って境界判定する。
 *   - **境界の表現は UTC Date 値**: 内部計算結果も常に Date オブジェクト (UTC ms) で返す。
 *     DB 比較や cron の閾値判定で同じ型を維持できる。
 *   - **「カレンダー日数経過」の意味**: TZ ローカルの YYYY-MM-DD 文字列比較で日数差を取る。
 *     例: テナント TZ Asia/Tokyo で createdAt が 2026-02-01 14:00 JST のとき、
 *     2026-05-02 09:00 JST 時点での「経過日数」は (2026-05-02 - 2026-02-01) = 90 日。
 *     絶対経過時間 (= 89.98 日) ではなく、カレンダー日付の差を取る。
 *
 * 関連:
 *   - schema: Tenant.timezone (PR-1 で追加)
 *   - 旧設計: src/services/beginner-expiry.service.ts (絶対経過時間ベース、PR-4 で TZ ベースに移行)
 *   - 旧設計: src/services/tenant-monthly-reset.service.ts (UTC 月初、PR-4 で TZ 月初に移行)
 */

/**
 * テナント TZ における「カレンダー日 YYYY-MM-DD」を返す。
 *
 * @param date 任意の Date (UTC ms)
 * @param timeZone IANA タイムゾーン名 (例 'Asia/Tokyo')
 * @returns 'YYYY-MM-DD' 文字列
 *
 * @example
 *   formatTenantDate(new Date('2026-02-01T15:00:00Z'), 'Asia/Tokyo') // → '2026-02-02'
 *   formatTenantDate(new Date('2026-02-01T15:00:00Z'), 'UTC')        // → '2026-02-01'
 */
export function formatTenantDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: 'year' | 'month' | 'day'): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * テナント TZ で 2 つの日付の「カレンダー日数」差を返す。
 *
 * 絶対経過時間 (= ミリ秒差 / 86400000) ではなく、TZ ローカルの YYYY-MM-DD 比較ベース。
 * 同 TZ 内で「日付が変わった回数」を意味する。
 *
 * @returns 日数 (laterDate >= earlierDate なら 0 以上)
 *
 * @example
 *   // JST で 2026-02-01 14:00 → 2026-02-02 09:00 (= 約 19 時間後、絶対経過 0 日)
 *   // しかしカレンダー日は 2026-02-01 → 2026-02-02 なので 1 日
 *   tenantCalendarDayDiff(
 *     new Date('2026-02-01T05:00:00Z'), // = 2026-02-01 14:00 JST
 *     new Date('2026-02-02T00:00:00Z'), // = 2026-02-02 09:00 JST
 *     'Asia/Tokyo'
 *   ) // → 1
 */
export function tenantCalendarDayDiff(
  earlier: Date,
  later: Date,
  timeZone: string,
): number {
  const e = formatTenantDate(earlier, timeZone);
  const l = formatTenantDate(later, timeZone);
  // 'YYYY-MM-DD' は UTC midnight として parse すれば日数差を絶対計算できる
  const eMs = Date.parse(`${e}T00:00:00Z`);
  const lMs = Date.parse(`${l}T00:00:00Z`);
  return Math.floor((lMs - eMs) / (24 * 60 * 60 * 1000));
}

/**
 * テナント TZ の「当月初」を返す (Date 値、UTC ms 単位)。
 *
 * @example
 *   // Asia/Tokyo で 2026-05-15 12:00 JST 時点の月初は 2026-05-01 00:00 JST = 2026-04-30 15:00 UTC
 *   getTenantMonthStart(new Date('2026-05-15T03:00:00Z'), 'Asia/Tokyo')
 *   // → Date('2026-04-30T15:00:00Z')
 */
export function getTenantMonthStart(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value); // 1-indexed
  return tenantLocalDateToUtc(year, month, 1, timeZone);
}

/**
 * テナント TZ の「翌月 1 日 00:00」を Date (UTC ms) で返す。
 *
 * @example
 *   // Asia/Tokyo で 2026-05-15 → 翌月初 = 2026-06-01 00:00 JST = 2026-05-31 15:00 UTC
 *   getTenantNextMonthStart(new Date('2026-05-15T03:00:00Z'), 'Asia/Tokyo')
 *   // → Date('2026-05-31T15:00:00Z')
 */
export function getTenantNextMonthStart(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value); // 1-indexed
  // 翌月: 12月なら次年1月、それ以外は month+1
  if (month === 12) return tenantLocalDateToUtc(year + 1, 1, 1, timeZone);
  return tenantLocalDateToUtc(year, month + 1, 1, timeZone);
}

/**
 * テナント TZ の「前月の YYYY-MM」文字列を返す (tenantMonthlyUsageHistory 用)。
 *
 * @example
 *   getTenantPreviousYearMonth(new Date('2026-05-15T03:00:00Z'), 'Asia/Tokyo') // → '2026-04'
 *   getTenantPreviousYearMonth(new Date('2026-01-15T03:00:00Z'), 'Asia/Tokyo') // → '2025-12'
 */
export function getTenantPreviousYearMonth(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  // 前月: 1月なら前年12月、それ以外は month-1
  if (month === 1) return `${year - 1}-12`;
  return `${year}-${String(month - 1).padStart(2, '0')}`;
}

/**
 * テナント TZ ローカル日付 (年/月/日) を UTC Date に変換する内部ヘルパ。
 *
 * 戦略: 「TZ ローカルでの YYYY-MM-DD 00:00:00 が UTC で何時か」を逆算する。
 * UTC midnight で起点を取り、その日が tenant TZ で何時かを formatToParts で読み、
 * 差分を引いて補正する。
 *
 * 例: ('Asia/Tokyo' で 2026-05-01 00:00 JST') = UTC で 2026-04-30 15:00:
 *   1. UTC midnight 候補: 2026-05-01T00:00:00Z
 *   2. その時刻を Tokyo TZ で見ると 2026-05-01T09:00 → 9 時間ずれている
 *   3. 9 時間引く: 2026-04-30T15:00:00Z ← 答え
 *
 * Note: DST 切替日は不整合がありうるが、Asia/Tokyo は DST なし、US/Europe でも
 *   切替時刻 (03:00 など) と月初 (00:00) はずれているため通常運用で問題ない。
 */
function tenantLocalDateToUtc(
  year: number,
  month: number, // 1-indexed
  day: number,
  timeZone: string,
): Date {
  // 候補 = その日の UTC midnight
  const candidate = Date.UTC(year, month - 1, day, 0, 0, 0);
  // 候補を tenant TZ で見たときの hour/minute/sec を読む
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(candidate));
  const localYear = Number(parts.find((p) => p.type === 'year')?.value);
  const localMonth = Number(parts.find((p) => p.type === 'month')?.value);
  const localDay = Number(parts.find((p) => p.type === 'day')?.value);
  let localHour = Number(parts.find((p) => p.type === 'hour')?.value);
  const localMinute = Number(parts.find((p) => p.type === 'minute')?.value);
  const localSecond = Number(parts.find((p) => p.type === 'second')?.value);
  // 'en-CA' で hour='24' が稀に返る (midnight 表記の揺れ) 対策
  if (localHour === 24) localHour = 0;
  // local 日付が候補と一致しているなら offset = local 時刻
  // 一致しないなら +/-1 日跨ぎなので補正する
  const localMs = Date.UTC(
    localYear,
    localMonth - 1,
    localDay,
    localHour,
    localMinute,
    localSecond,
  );
  const offsetMs = localMs - candidate;
  return new Date(candidate - offsetMs);
}

/**
 * テナント TZ の「現在のカレンダー日」を返す (テスト容易性のため now 引数化)。
 *
 * @example getTenantTodayString(new Date('2026-05-15T16:00:00Z'), 'Asia/Tokyo') // → '2026-05-16'
 */
export function getTenantTodayString(now: Date, timeZone: string): string {
  return formatTenantDate(now, timeZone);
}
