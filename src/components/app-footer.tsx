/**
 * 全画面共通フッタ (feat/app-version-changelog-footer / 2026-05-23)。
 *
 * 表示位置: root layout の <body> 直下、children の **後** に配置する。
 * <body> は `flex min-h-full flex-col` のため、本コンポーネントの `mt-auto` で
 * 画面下に押し下げられる。children 側に `flex-1` を持たせる必要はない。
 *
 * 構成意図:
 *   - 「サービスが健全に運営されていることが一目で分かる」ことが目的 (PR 起票時の方針)
 *   - そのため「バージョン + 最終更新日 + 運営者」をひとまとめに最初の段に出す
 *   - リンク類は別段に分け、視線移動を 1 → 2 段で完結させる
 *   - text-xs + muted で本文より目立たず、しかし常に視認できる距離感を保つ
 *
 * 外部リンク:
 *   利用規約 / プライバシーは LP (HomePage) の anchor URL 経由 (src/config/legal-versions.ts)。
 *   問い合わせは LP contact form (src/config/operator.ts の CONTACT_FORM_URL)。
 *
 * Server Component で実装 (state 不要、SEO / 初回描画速度を優先)。
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { OPERATOR_LABEL, OPERATOR_NAME, CONTACT_FORM_URL } from '@/config/operator';
import { PRIVACY_URL, TERMS_URL } from '@/config/legal-versions';
import { formatVersionLabel, getReleaseDate } from '@/lib/app-version';

export async function AppFooter() {
  const t = await getTranslations('footer');
  const tApp = await getTranslations('app');
  const year = new Date().getFullYear();

  return (
    <footer
      className="mt-auto border-t border-border bg-background/50 px-4 py-4 text-xs text-muted-foreground sm:px-6 lg:px-8"
      data-testid="app-footer"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-2">
        {/* 1 段目: サービス名 + バージョン + 運営者. flex-wrap でモバイル対応. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium text-foreground/80">
            {tApp('metaTitle')}
          </span>
          <span aria-hidden="true">·</span>
          <span data-testid="footer-version">{formatVersionLabel()}</span>
          <span aria-hidden="true">·</span>
          <span>
            {t('operatorPrefix')}: {OPERATOR_NAME}
          </span>
        </div>

        {/* 2 段目: 主要リンク. 内部リンクと外部リンクが混在するため rel/target を明示. */}
        <nav
          className="flex flex-wrap items-center gap-x-3 gap-y-1"
          aria-label={t('about')}
        >
          <Link href="/settings/about" className="hover:underline">
            {t('about')}
          </Link>
          <span aria-hidden="true">·</span>
          <Link href="/changelog" className="hover:underline">
            {t('changelog')}
          </Link>
          <span aria-hidden="true">·</span>
          <Link href="/announcements" className="hover:underline">
            {t('announcements')}
          </Link>
          <span aria-hidden="true">·</span>
          <a
            href={TERMS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            {t('terms')}
          </a>
          <span aria-hidden="true">·</span>
          <a
            href={PRIVACY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            {t('privacy')}
          </a>
          <span aria-hidden="true">·</span>
          <a
            href={CONTACT_FORM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            {t('contact')}
          </a>
        </nav>

        {/* 3 段目: copyright + 最終更新日. 「健全運営」の継続性アピールを担う. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
          <span>{t('copyright', { year, operator: OPERATOR_LABEL })}</span>
          <span aria-hidden="true">·</span>
          <span>
            {t('lastUpdated')}: {getReleaseDate()}
          </span>
        </div>
      </div>
    </footer>
  );
}
