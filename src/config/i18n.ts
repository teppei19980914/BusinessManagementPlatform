/**
 * 国際化 (i18n) + タイムゾーン設定 (PR #118)。
 *
 * 3 段階のフォールバック:
 *   1. ユーザ個別設定 (User.timezone / User.locale)     — 設定画面で変更 (PR #119)
 *   2. システムデフォルト (このファイルの定数)           — リポジトリ同梱の既定値
 *   3. 環境変数 (APP_DEFAULT_TIMEZONE / APP_DEFAULT_LOCALE) — 環境ごとの上書き
 *
 * 設計意図:
 *   - DB は常に UTC。描画時に TZ/locale を解決する方針 (DESIGN.md 関連章参照)。
 *   - オンプレミス・クラウド・ローカル展開を視野に、env で上書き可能にする。
 *   - ユーザ未設定時はシステム値、システム値未設定時は env 値、env も未設定なら日本向け既定。
 *
 * SSR/CSR 一貫性:
 *   `Intl.DateTimeFormat` は timeZone/locale を明示すれば実行環境に依存せず同じ文字列を返す。
 *   したがって server と client が同じ resolved 値を使っている限りハイドレーション安全。
 */

/**
 * IANA タイムゾーン名 (例: 'Asia/Tokyo', 'America/New_York', 'UTC')。
 * 空文字列の場合は FALLBACK を使用。
 */
const ENV_TIMEZONE = process.env.APP_DEFAULT_TIMEZONE?.trim();

/**
 * BCP 47 ロケールタグ (例: 'ja-JP', 'en-US')。
 * 空文字列の場合は FALLBACK を使用。
 */
const ENV_LOCALE = process.env.APP_DEFAULT_LOCALE?.trim();

/**
 * 最終フォールバック (env も未設定かつ useSystemDefault=true な時の既定値)。
 * 変更する場合はこの 2 行を編集する。
 */
const FALLBACK_TIMEZONE = 'Asia/Tokyo';
const FALLBACK_LOCALE = 'ja-JP';

/**
 * システムデフォルトのタイムゾーン (env 優先、なければ FALLBACK)。
 * 描画時に user 個別設定が無い場合に使う既定値。
 */
export const DEFAULT_TIMEZONE: string = ENV_TIMEZONE || FALLBACK_TIMEZONE;

/**
 * システムデフォルトのロケール (env 優先、なければ FALLBACK)。
 */
export const DEFAULT_LOCALE: string = ENV_LOCALE || FALLBACK_LOCALE;

/**
 * ユーザ個別設定を優先してタイムゾーンを解決する。
 *
 * @param userTimezone User.timezone (null/undefined/空文字可)
 * @returns IANA タイムゾーン名 (必ず非空文字列)
 */
export function resolveTimezone(userTimezone: string | null | undefined): string {
  const trimmed = userTimezone?.trim();
  return trimmed || DEFAULT_TIMEZONE;
}

/**
 * ユーザ個別設定を優先してロケールを解決する。
 *
 * @param userLocale User.locale (null/undefined/空文字可)
 * @returns BCP 47 ロケールタグ (必ず非空文字列)
 */
export function resolveLocale(userLocale: string | null | undefined): string {
  const trimmed = userLocale?.trim();
  return trimmed || DEFAULT_LOCALE;
}

/**
 * サポート対象ロケール一覧。
 * UI (設定画面) のセレクトボックスで使用する。
 * 追加時は `src/i18n/messages/<locale>.json` のメッセージカタログも追加すること。
 */
export const SUPPORTED_LOCALES = {
  'ja-JP': '日本語',
  'en-US': 'English',
} as const;

export type SupportedLocale = keyof typeof SUPPORTED_LOCALES;

/**
 * 与えられた値が SUPPORTED_LOCALES に含まれるかを判定する (DB 汚染防止ガード)。
 */
export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && value in SUPPORTED_LOCALES;
}

/**
 * 与えられた値が IANA タイムゾーンとして有効かを判定する (DB 汚染防止ガード)。
 * `Intl.supportedValuesOf('timeZone')` は大量 (400+ 件) なので都度参照する形にする。
 */
export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    // Intl.DateTimeFormat は未知の timeZone に対して RangeError を投げる。
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
