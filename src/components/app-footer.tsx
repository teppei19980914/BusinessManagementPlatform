/**
 * 全画面共通フッタ
 * (初版 feat/app-version-changelog-footer / 2026-05-23,
 *  改 feat/app-header-footer-unification / 2026-05-24).
 *
 * 表示位置: root layout の <body> 直下、children の **後** に配置する。
 * <body> は `flex min-h-full flex-col` のため、本コンポーネントの `mt-auto` で
 * 画面下に押し下げられる。children 側に `flex-1` を持たせる必要はない。
 *
 * 構成意図 (2026-05-24 改訂):
 *   - 「画面上の表示項目を極力減らし UX 向上に寄せる」方針に沿ってコンテンツを削減
 *   - 1 段目 (旧: サービス名 + バージョン + 運営者) は削除 → 高さ圧縮
 *   - 2 段目 (リンク群) は **サービス情報 / お知らせ** の 2 リンクのみに削減
 *     - 旧 1 段目の情報 (サービス名 / バージョン / 運営者) と
 *       旧 2 段目の他リンク (更新履歴 / 利用規約 / プライバシー / お問い合わせ) は
 *       全て `/settings/about` (サービス情報) ページに集約済 → footer は「玄関」のみ提供
 *   - 3 段目 (copyright + 最終更新日) は維持
 *     - 「健全運営シグナル」(© 運営者 + 最終更新日) は footer に残す。ユーザがどのページに
 *       いてもサービスが稼働中であることが一目で分かる UX を保つ。
 *
 * auto-hide 対象外 (案 B / 2026-05-24):
 *   フッタは fixed/sticky ではなく document 末尾の自然位置に置く (mt-auto)。
 *   理由は「コンテンツ領域を圧迫しない」設計選択。AppHeader と挙動が非対称に見えるが、
 *   そもそも下スクロール時にはフッタは既に画面外なので「隠す」対象が存在しない。
 *   将来 fixed-bottom 化を検討する際は ChatSemanticSearchFab (fixed bottom-4) と
 *   Toast (fixed bottom-0 z-50) との重なり調整が必須。一貫性を理由に勝手に変更しないこと。
 *
 * 外部リンク:
 *   footer からは全廃。利用規約 / プライバシーポリシー / お問い合わせは /settings/about へ集約。
 *
 * Server Component で実装 (state 不要、SEO / 初回描画速度を優先)。
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { OPERATOR_LABEL } from '@/config/operator';
import { getReleaseDate } from '@/lib/app-version';

export async function AppFooter() {
  const t = await getTranslations('footer');
  const year = new Date().getFullYear();

  return (
    <footer
      className="mt-auto border-t border-border bg-background/50 px-4 py-3 text-xs text-muted-foreground sm:px-6 lg:px-8"
      data-testid="app-footer"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-1">
        {/* 1 段目: 主要リンク (about / announcements の 2 件のみ) */}
        <nav
          className="flex flex-wrap items-center gap-x-3 gap-y-1"
          aria-label={t('about')}
        >
          <Link href="/settings/about" className="hover:underline">
            {t('about')}
          </Link>
          <span aria-hidden="true">·</span>
          <Link href="/announcements" className="hover:underline">
            {t('announcements')}
          </Link>
        </nav>

        {/* 2 段目: copyright + 最終更新日 ("健全運営シグナル" の最小単位) */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
          <span>{t('copyright', { year, operator: OPERATOR_LABEL })}</span>
          <span aria-hidden="true">·</span>
          <span data-testid="footer-last-updated">
            {t('lastUpdated')}: {getReleaseDate()}
          </span>
        </div>
      </div>
    </footer>
  );
}
