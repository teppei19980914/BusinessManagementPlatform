/**
 * 公開ページ (認証不要) 共通レイアウト
 * (初版 feat/app-version-changelog-footer / 2026-05-23,
 *  改 feat/app-header-footer-unification / 2026-05-24).
 *
 * 対象ページ:
 *   - /changelog (バージョン更新履歴)
 *   - /announcements (お知らせ一覧)
 *   - /announcements/[slug] (お知らせ詳細)
 *
 * 設計方針:
 *   - 認証不要のため、`requireAuthForLayout()` (= 未認証で /login redirect) は使えない
 *   - 一方で NextAuth の auth() 直接呼出も tokenVersion 検証が抜ける + CI ガード (KDD §5.X+84) で
 *     禁止されている。両者を満たす `optionalAuthForLayout()` (= 失効済 cookie を null 扱い)
 *     を経由する (KDD §5.X+120)
 *   - feat/app-header-footer-unification: 旧インラインヘッダを削除し全画面共通 AppHeader に統合。
 *     ログイン済なら user を渡してナビ + AccountMenu を表示、未ログインなら user=null で
 *     ロゴ + ログイン CTA のみのモードに切替
 *   - 全画面共通の AppFooter は root layout で出力済 → 重複描画しない
 *   - 旧 testid `public-header-home` は AppHeader 内の `app-header-home` に統合済
 */

import { optionalAuthForLayout } from '@/lib/page-auth';
import { AppHeader } from '@/components/app-header';

export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const sessionUser = await optionalAuthForLayout();
  const headerUser = sessionUser
    ? {
        name: sessionUser.name ?? '',
        email: sessionUser.email ?? '',
        systemRole: sessionUser.systemRole ?? 'general',
      }
    : null;

  return (
    <div className="min-h-screen bg-background">
      <AppHeader user={headerUser} />
      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
