/**
 * 表示用フォーマッタユーティリティ (PR #63 → PR #117 ハイドレーション対応 → PR #118 i18n 化)。
 *
 * DRY 原則 (DESIGN.md §21.2): 複数画面で重複していた書式整形ロジックを集約する。
 *
 * 設計の変遷:
 *   - PR #63: 素の `d.getFullYear()` ベースで `formatDateTime` を新設
 *   - PR #117: runtime TZ 依存で React #418 (hydration mismatch) が発生 →
 *             `Intl.DateTimeFormat` で `timeZone: 'Asia/Tokyo'` 固定に変更
 *   - PR #118: JST ハードコードを廃止し `{ timeZone, locale }` オプション化。
 *             引数なし呼び出しは `DEFAULT_TIMEZONE` / `DEFAULT_LOCALE` (config/i18n.ts) を使用。
 *
 * SSR/CSR 一貫性:
 *   `Intl.DateTimeFormat` に timeZone/locale を明示すれば実行環境に非依存。
 *   サーバとクライアントが同じ値を渡せばハイドレーション安全。
 *   session.user.timezone / session.user.locale を通して JWT で両環境に共有する。
 *
 * 使い方:
 *   - 引数なし: システムデフォルト (config/i18n.ts の FALLBACK or env) で描画
 *       `formatDate(iso)`
 *   - ユーザ設定を反映: `session.user.timezone` / `session.user.locale` を渡す
 *       `formatDate(iso, { timeZone: session.user.timezone, locale: session.user.locale })`
 *       null を渡すと自動で DEFAULT にフォールバック (resolveTimezone/resolveLocale 経由)。
 */

import { DEFAULT_TIMEZONE, DEFAULT_LOCALE, resolveTimezone, resolveLocale } from '@/config/i18n';

export type FormatOptions = {
  /** IANA タイムゾーン名。null/undefined なら DEFAULT_TIMEZONE にフォールバック */
  timeZone?: string | null;
  /** BCP 47 ロケール。null/undefined なら DEFAULT_LOCALE にフォールバック */
  locale?: string | null;
};

/**
 * DateTimeFormat インスタンスキャッシュ。
 * (locale, tz) の組み合わせごとに最大 1 インスタンスを生成して使い回す。
 * 大多数のユーザは同じ組み合わせを使うためメモリ影響は軽微。
 */
const dateTimeCache = new Map<string, Intl.DateTimeFormat>();
const dateCache = new Map<string, Intl.DateTimeFormat>();

function getDateTimeFormatter(locale: string, timeZone: string): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}`;
  let fmt = dateTimeCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    dateTimeCache.set(key, fmt);
  }
  return fmt;
}

function getDateFormatter(locale: string, timeZone: string): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}`;
  let fmt = dateCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateCache.set(key, fmt);
  }
  return fmt;
}

/**
 * ISO 日時文字列を「YYYY-MM-DD HH:MM」形式 (区切り文字固定) で整形する。
 *
 * - 出力形式は locale に依存せず常に `-` と `:` 区切り (既存 UI との互換性確保)。
 * - 日時 "値" (年/月/日/時/分) は timeZone/locale で解釈される。
 */
export function formatDateTime(iso: string, opts: FormatOptions = {}): string {
  const tz = resolveTimezone(opts.timeZone);
  const loc = resolveLocale(opts.locale);
  const parts = getDateTimeFormatter(loc, tz).formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/**
 * ISO 日付/日時文字列を日付のみ (locale の日付形式) で整形する。
 *
 * 例: ja-JP なら `2026/04/24`、en-US なら `04/24/2026`。
 */
export function formatDate(iso: string, opts: FormatOptions = {}): string {
  const tz = resolveTimezone(opts.timeZone);
  const loc = resolveLocale(opts.locale);
  return getDateFormatter(loc, tz).format(new Date(iso));
}

/**
 * ISO 日時文字列を詳細形式 (locale の日付+時刻形式) で整形する (title / tooltip 等)。
 */
export function formatDateTimeFull(iso: string, opts: FormatOptions = {}): string {
  const tz = resolveTimezone(opts.timeZone);
  const loc = resolveLocale(opts.locale);
  return getDateTimeFormatter(loc, tz).format(new Date(iso));
}

// PR #118: テスト / デバッグ用途で現在の解決済みデフォルト値を参照できるようにする。
export { DEFAULT_TIMEZONE, DEFAULT_LOCALE };
