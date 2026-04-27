/**
 * next-intl のサーバ設定 (PR #77 Phase A → PR #169 で session.user.locale 連携 + en-US 対応)。
 *
 * 解決順序 (DESIGN.md §21.4.5 + src/config/i18n.ts §3 段フォールバック):
 *   1. **認証ユーザの個別設定**: `auth().user.locale` (設定画面で変更、PR #119)
 *   2. **システムデフォルト**: `resolveLocale()` 経由で env `APP_DEFAULT_LOCALE` or 'ja-JP'
 *   3. **未サポートロケール → 'ja' フォールバック**
 *
 * 注意:
 *   - ロケール解決は `resolveLocale()` を使い、`auth()` から取得した user.locale を渡す
 *   - SELECTABLE_LOCALES が false のロケールが session に残っている場合 (UI 切替前の状態) でも
 *     ファイル存在チェックを `toMessagesFilename` で行うため壊れない
 *   - en-US カタログは PR #169 で雛形作成済、本格翻訳は §11 T-06 (en-US 完全有効化) で実施
 *
 * 既存 SUPPORTED_LOCALES (この file 内) は **next-intl 内部用の messages/ ファイル名**。
 * BCP 47 形式 (`ja-JP` / `en-US`) は `src/config/i18n.ts` 側で扱う。本 file では
 * messages/ ディレクトリのファイル名と一致する短縮形 (`ja` / `en-US`) を使う。
 */

import { getRequestConfig } from 'next-intl/server';
import { auth } from '@/lib/auth';
import { resolveLocale } from '@/config/i18n';

/** next-intl の messages/<locale>.json と一致するファイル名。 */
export const SUPPORTED_LOCALES = ['ja', 'en-US'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** 既定ロケール。未認証ページや locale 未解決時に適用される。 */
export const DEFAULT_LOCALE: Locale = 'ja';

/**
 * BCP 47 形式 (`ja-JP` / `en-US`) を messages/ ファイル名 (`ja` / `en-US`) に変換する。
 * `ja-JP` は messages/ja.json として保存しているため特別扱い。
 */
function toMessagesFilename(bcp47: string): Locale {
  if (bcp47 === 'en-US') return 'en-US';
  // 'ja-JP' / 'ja' / 未知ロケールはすべて 'ja' にフォールバック
  return 'ja';
}

export default getRequestConfig(async () => {
  // 認証ユーザの locale を取得 (未認証/未設定なら system default を返す)
  let userLocale: string | null = null;
  try {
    const session = await auth();
    userLocale = session?.user?.locale ?? null;
  } catch {
    // auth() は middleware 等の特殊な context で throw しうる。安全側にフォールバック
    userLocale = null;
  }

  const bcp47 = resolveLocale(userLocale);
  const locale = toMessagesFilename(bcp47);

  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
  };
});
