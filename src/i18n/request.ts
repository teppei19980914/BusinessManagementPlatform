/**
 * next-intl のサーバ設定 (PR #77 Phase A):
 *
 *   各リクエスト時に locale と messages を解決して next-intl に渡す。
 *   現状は単一 locale (`ja`) のみ運用。将来 locale 切替を導入する場合は、
 *   ここでクッキー / URL セグメント / Accept-Language ヘッダから判定するよう拡張する。
 *
 *   設計書: DESIGN.md §21.4.5 (UI ラベル外出しと next-intl 導入指針)
 */

import { getRequestConfig } from 'next-intl/server';

/** 現在サポートされているロケール一覧 (将来増えたらここに追加)。 */
export const SUPPORTED_LOCALES = ['ja'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** 既定ロケール。未認証ページや locale 未解決時に適用される。 */
export const DEFAULT_LOCALE: Locale = 'ja';

export default getRequestConfig(async () => {
  const locale: Locale = DEFAULT_LOCALE;
  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
  };
});
