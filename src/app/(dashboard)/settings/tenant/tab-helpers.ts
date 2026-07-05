/**
 * feat/tenant-settings-tabs (2026-05-22): テナント設定画面の 3 タブ構成補助。
 *
 * tenant-settings-client.tsx から切り出した純粋関数。Client Component 本体を import すると
 * React / next-intl / 依存サービス全てが vitest 解決対象になるため、テスト容易性のため別ファイル化。
 */

/**
 * タブ識別子。
 *   overview = 概要 (プラン / 設定 / データ管理 / 解約)
 *   usage    = 使用量 (API 当月使用量 / ストレージ / 縮退モード警告)
 *   billing  = 請求 (請求先 / 支払い方法 / 請求履歴リンク)
 *   banner   = バナー (自テナントユーザ向け帯メッセージ管理 ADR-0037)
 */
export type TenantSettingsTab = 'overview' | 'usage' | 'billing' | 'banner';

export const TENANT_SETTINGS_TABS: ReadonlyArray<TenantSettingsTab> = ['overview', 'usage', 'billing', 'banner'];

/**
 * URL クエリ `?tab=` の値を厳格な型に解決。不正値 / null / undefined は 'overview' フォールバック。
 *
 * Why: Stripe Checkout からの戻りで悪意のあるクエリが付与された場合や、
 *   旧 URL に未知の tab 値が含まれていた場合に画面が壊れないようにする防御層。
 */
export function pickInitialTab(raw: string | null | undefined): TenantSettingsTab {
  if (raw && (TENANT_SETTINGS_TABS as ReadonlyArray<string>).includes(raw)) {
    return raw as TenantSettingsTab;
  }
  return 'overview';
}

/**
 * Stripe Checkout 戻り時の URL クリーニング: `stripe_setup` / `reason` だけ除去し、
 * `tab` 等のユーザ操作上有意なクエリは保持する。
 *
 * Why: feat/tenant-settings-tabs で `?tab=billing` が導入されたため、
 *   旧実装の `router.replace('/settings/tenant')` (全クエリ消去) では
 *   Stripe 成功後に概要タブへ吹き飛ばされてしまう (= ユーザがカード登録した動線から離れる)。
 */
export function buildStripeCleanedUrl(
  searchParams: URLSearchParams | { toString(): string },
): string {
  const params = new URLSearchParams(searchParams.toString());
  params.delete('stripe_setup');
  params.delete('reason');
  const queryString = params.toString();
  return queryString ? `/settings/tenant?${queryString}` : '/settings/tenant';
}
