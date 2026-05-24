/**
 * 公開ページ (認証不要) 共通レイアウト
 * (初版 feat/app-version-changelog-footer / 2026-05-23, 改 feat/app-header-footer-unification / 2026-05-24)。
 *
 * 対象ページ:
 *   - /changelog (バージョン更新履歴)
 *   - /announcements (お知らせ一覧)
 *   - /announcements/[slug] (お知らせ詳細)
 *
 * 設計方針:
 *   - 認証不要のため、`requireAuthForLayout()` などのガードは入れない
 *     (PUBLIC_PATHS で middleware を通過させる側で担保)
 *   - feat/app-header-footer-unification (2026-05-24): 旧インラインヘッダを削除し
 *     全画面共通の AppHeader (user=null) に統合。ロゴ位置・高さ・色・auto-hide 挙動を
 *     (dashboard) / (auth) と揃え、「同じ役割は同じ UI」を担保する
 *   - 全画面共通の AppFooter は root layout で出力済 → 重複描画しない
 *   - 旧 testid `public-header-home` は AppHeader 内の `app-header-home` に統合済
 */

import { auth } from '@/lib/auth';
import { AppHeader } from '@/components/app-header';

export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 公開ページでもログイン済ユーザがアクセスし得る (/changelog 等)。
  // session があれば user を AppHeader に渡して通常のナビ + AccountMenu を出す。
  // session が無ければ null を渡してログイン CTA のみのモードにする。
  const session = await auth();
  const user = session?.user
    ? {
        name: session.user.name ?? '',
        email: session.user.email ?? '',
        systemRole: session.user.systemRole ?? 'general',
      }
    : null;

  return (
    <div className="min-h-screen bg-background">
      <AppHeader user={user} />
      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
