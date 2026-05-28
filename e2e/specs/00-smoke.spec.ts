/**
 * E2E スモークテスト (PR #90 基盤)。
 *
 * 目的:
 *   CI 環境構築とブラウザ起動の疎通確認のみ。本番ロジックには踏み込まない。
 *   具体シナリオ (Steps 1-12) は後続 PR (B〜E) で追加する。
 *
 * カバレッジ記録: docs/developer/E2E_COVERAGE.md の「ログイン画面」行にマッピング
 */

import { test, expect } from '@playwright/test';

test.describe('@feature:auth:login スモーク', () => {
  test('ログイン画面が表示される', async ({ page }) => {
    await page.goto('/login');
    // 注: ログイン画面のサービス名は shadcn CardTitle (実装は <div>) で描画しているため
    // heading role を持たない。data-testid="auth-app-name-title" 経由で参照する。
    //
    // LESSONS §4.25: page.goto は "load" イベントまでしか待たず、React 19 / Next.js 16
    // の Suspense streaming 過渡期では同一 CardTitle ノードが DOM に一瞬重複して
    // 観測される (PR #98 CI で smoke が strict mode violation で fail、Retry #2 で
    // settle して成功)。hydration 完了まで待ってから assertion する。
    //
    // KDD §5.X+159 (feat/mascot-owl 2026-05-27 / PR #451): 旧 getByText('たすきば', { exact: true }).first()
    // は AppHeader のサービス名と CardTitle の 2 箇所マッチしていた。AppHeader が
    // モバイル時はテキストを sm:inline で hide するようになったため、chromium-mobile で
    // .first() が「AppHeader span (display: none)」を拾い toBeVisible() が fail する事故が発生。
    // CardTitle 側に data-testid を付け、テストを scoped locator に変更して回避。
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('auth-app-name-title')).toBeVisible();
    // 2026-05-28 (feat/login-setup-guide-link): CardHeader 左に たすきフクロウ画像を配置。
    //   AppHeader と同じ /mascot-owl.png を使用し、サービス名と一体感のあるロゴ的扱い。
    await expect(page.getByTestId('login-mascot-owl')).toBeVisible();
    // ADR-0016 (2026-05-20): 組織 ID 入力欄が必須化
    await expect(page.getByLabel('組織 ID')).toBeVisible();
    await expect(page.getByLabel('メールアドレス')).toBeVisible();
    await expect(page.getByLabel('パスワード')).toBeVisible();
  });

  test('不正なメールアドレスでログイン失敗 (enumeration 対策: 一般エラー文言)', async ({ page }) => {
    await page.goto('/login');
    // ADR-0016 (2026-05-20): 存在しない tenantSlug でも汎用エラーで返る (enumeration 対策)
    await page.getByLabel('組織 ID').fill('management');
    await page.getByLabel('メールアドレス').fill('nobody@example.com');
    await page.getByLabel('パスワード').fill('wrong-password');
    await page.getByRole('button', { name: 'ログイン' }).click();
    await expect(
      page.getByText('メールアドレスまたはパスワードが正しくありません'),
    ).toBeVisible();
  });

  // 2026-05-28 (feat/login-setup-guide-link): 招待制案内文言 + 利用規約/プラポリリンクを撤去し、
  //   外部 LP の「初回ログイン手順ガイド」(tasukiba-setup-guide) へ一本化。
  //   サービスは引き続き招待制運用だが、ログイン画面に「招待制です」を明示する必要は
  //   無くなった (テナント管理者は招待された時点で運用方針を理解しているため)。
  //   利用規約 / プライバシーポリシー はサインアップ同意フォーム (TenantConsentLog 証跡) と
  //   /settings/about (認証後) で引き続き担保するため、login footer からは外す。
  //   本テストではセットアップガイドリンクの href + target + rel 属性を検証 (実 LP の到達性は
  //   HomePage repo 側で担保)。
  test('@feature:public ログイン画面にセットアップガイドリンクが表示される', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    const footer = page.getByTestId('login-public-footer');
    await expect(footer).toBeVisible();
    const link = footer.getByTestId('login-setup-guide-link');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute(
      'href',
      'https://teppei19980914.github.io/HomePage/ja/product/tasukiba-setup-guide/',
    );
    // 外部リンクは新タブで開く + reverse-tabnabbing 対策
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
