/**
 * 全画面共通フッタ
 * (初版 feat/app-version-changelog-footer / 2026-05-23,
 *  改 feat/app-header-footer-unification / 2026-05-24,
 *  改 feat/footer-auth-aware-links / 2026-05-31).
 *
 * 表示位置: root layout の <body> 直下、children の **後** に配置する。
 * <body> は `flex min-h-full flex-col` のため、本コンポーネントの `mt-auto` で
 * 画面下に押し下げられる。children 側に `flex-1` を持たせる必要はない。
 *
 * 構成意図 (2026-05-31 改訂 — 認証状態で出し分け):
 *   - ユーザ要望「情報最小化ポリシー + 二重管理防止」に沿い、フッタを 2 層に再編。
 *     1. **共通情報** (ログイン前後で常時表示):
 *        製品ページ / 利用規約 / プライバシーポリシー / 運営者情報 / 特定商取引法に基づく表記
 *        → すべて外部 LP (tasukiba-user ページ) の各アンカーへ集約 (= サービス内に
 *          二重に持たず LP を単一真値にする)。未ログインのログイン / MFA 画面でも
 *          「サービスの素性」は確認できるべき法定・運営情報のみに絞る。
 *     2. **ログイン後限定情報** (`isAuthenticated` のときだけ追加表示):
 *        お知らせ (アプリ内 /announcements) / セキュリティ報告 (LP #security)
 *        → 未ログイン状態でサービス運用情報・報告経路を前面に出さない方針。
 *   - 旧「© 運営者」「最終更新日」「サービス情報 (/settings/about)」は **全廃**。
 *     - 運営者情報は LP `#operator-info` に集約 (重複排除)。
 *     - バージョン / 更新履歴はヘッダ右上 AccountMenu の「バージョンアップ情報」
 *       (→ /changelog) に移設 (ログイン後のみ到達可能)。
 *     - `/settings/about` ページは役割を失ったため本 PR で削除。
 *
 * auto-hide 対象外 (案 B / 2026-05-24):
 *   フッタは fixed/sticky ではなく document 末尾の自然位置に置く (mt-auto)。
 *   理由は「コンテンツ領域を圧迫しない」設計選択。AppHeader と挙動が非対称に見えるが、
 *   そもそも下スクロール時にはフッタは既に画面外なので「隠す」対象が存在しない。
 *   将来 fixed-bottom 化を検討する際は ChatSemanticSearchFab (fixed bottom-4) と
 *   Toast (fixed bottom-0 z-50) との重なり調整が必須。一貫性を理由に勝手に変更しないこと。
 *
 * 外部リンク:
 *   共通情報リンクは LP への外部遷移のため target="_blank" + rel="noopener noreferrer"。
 *   ログイン後限定の「お知らせ」のみアプリ内遷移 (next/link)。
 *
 * Server Component で実装 (state 不要、SEO / 初回描画速度を優先)。
 * 認証状態は親 (root layout) が `auth()` で解決し props で受け取る (本体は DB を引かない)。
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  PRODUCT_USER_PAGE_URL,
  TERMS_URL,
  PRIVACY_URL,
  OPERATOR_INFO_URL,
  TOKUSHOHO_URL,
  SECURITY_REPORT_URL,
} from '@/config/legal-versions';

type AppFooterProps = {
  /**
   * ログイン後 (= 完全認証済) かどうか。true のときだけ「お知らせ / セキュリティ報告」を
   * 追加表示する。MFA 検証前 (mfaVerified=false) は false 扱いで共通情報のみ表示する。
   */
  isAuthenticated: boolean;
};

/** 外部 LP への共通情報リンク (ログイン前後で常時表示)。 */
function ExternalFooterLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:underline"
    >
      {label}
    </a>
  );
}

export async function AppFooter({ isAuthenticated }: AppFooterProps) {
  const t = await getTranslations('footer');

  return (
    <footer
      className="mt-auto border-t border-border bg-background/50 px-4 py-3 text-xs text-muted-foreground sm:px-6 lg:px-8"
      data-testid="app-footer"
      data-authenticated={isAuthenticated ? 'true' : 'false'}
    >
      <nav
        className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1"
        aria-label={t('navLabel')}
        data-testid="app-footer-nav"
      >
        {/* 共通情報 (ログイン前後で常時表示): すべて外部 LP の各アンカーへ集約 */}
        <ExternalFooterLink href={PRODUCT_USER_PAGE_URL} label={t('productPage')} />
        <span aria-hidden="true">·</span>
        <ExternalFooterLink href={TERMS_URL} label={t('terms')} />
        <span aria-hidden="true">·</span>
        <ExternalFooterLink href={PRIVACY_URL} label={t('privacy')} />
        <span aria-hidden="true">·</span>
        <ExternalFooterLink href={OPERATOR_INFO_URL} label={t('operatorInfo')} />
        <span aria-hidden="true">·</span>
        <ExternalFooterLink href={TOKUSHOHO_URL} label={t('tokushoho')} />

        {/* ログイン後限定情報: お知らせ (アプリ内) / セキュリティ報告 (LP #security) */}
        {isAuthenticated && (
          <>
            <span aria-hidden="true">·</span>
            <Link
              href="/announcements"
              className="hover:underline"
              data-testid="app-footer-announcements"
            >
              {t('announcements')}
            </Link>
            <span aria-hidden="true">·</span>
            <a
              href={SECURITY_REPORT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
              data-testid="app-footer-security-report"
            >
              {t('securityReport')}
            </a>
          </>
        )}
      </nav>
    </footer>
  );
}
