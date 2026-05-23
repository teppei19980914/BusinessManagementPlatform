/**
 * 公開ページ (認証不要) 共通レイアウト (feat/app-version-changelog-footer / 2026-05-23)。
 *
 * 対象ページ:
 *   - /changelog (バージョン更新履歴)
 *   - /announcements (お知らせ一覧)
 *   - /announcements/[slug] (お知らせ詳細)
 *
 * 設計方針:
 *   - 認証不要のため、`requireAuthForLayout()` などのガードは入れない
 *     (PUBLIC_PATHS で middleware を通過させる側で担保)
 *   - 既存の (auth) ページ群が個別 layout を持っていない設計に合わせ、本 layout も
 *     最小限の container + 軽い header (アプリ名 + サインインへの導線) のみ
 *   - 全画面共通の AppFooter は root layout で出力済 → 重複描画しない
 *   - `(dashboard)` の DashboardHeader と違い、認証ユーザ向けナビは出さない
 *     (未ログインユーザでも閲覧できることを意図したページ群のため)
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const tApp = await getTranslations('app');
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3 sm:px-6">
          <Link
            href="/"
            className="text-sm font-semibold hover:underline"
            data-testid="public-header-home"
          >
            {tApp('metaTitle')}
          </Link>
          <Link
            href="/login"
            className="text-xs text-muted-foreground hover:underline"
          >
            ログイン
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
