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
    // heading role を持たない。テストは getByText でテキスト一致を検証する。
    // (意図的な設計。heading にしたい場合は CardTitle を h1/h2 に変更する別タスク)
    //
    // LESSONS §4.25: page.goto は "load" イベントまでしか待たず、React 19 / Next.js 16
    // の Suspense streaming 過渡期では同一 CardTitle ノードが DOM に一瞬重複して
    // 観測される (PR #98 CI で smoke が strict mode violation で fail、Retry #2 で
    // settle して成功)。hydration 完了まで待ってから assertion する。
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('たすきば', { exact: true }).first()).toBeVisible();
    await expect(page.getByLabel('メールアドレス')).toBeVisible();
    await expect(page.getByLabel('パスワード')).toBeVisible();
  });

  test('不正なメールアドレスでログイン失敗 (enumeration 対策: 一般エラー文言)', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('メールアドレス').fill('nobody@example.com');
    await page.getByLabel('パスワード').fill('wrong-password');
    await page.getByRole('button', { name: 'ログイン' }).click();
    await expect(
      page.getByText('メールアドレスまたはパスワードが正しくありません'),
    ).toBeVisible();
  });

  // 2026-05-19 (docs/2026-05-19-roadmap-archive): 初見訪問者案内 + 利用規約 /
  //   プライバシーポリシーへの導線が表示されることを検証
  test('@feature:public ログイン画面に招待制案内と公開ページリンクが表示される', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    const footer = page.getByTestId('login-public-footer');
    await expect(footer).toBeVisible();
    await expect(footer).toContainText('招待制');
    await expect(footer.getByRole('link', { name: '利用規約' })).toHaveAttribute('href', '/terms');
    await expect(footer.getByRole('link', { name: 'プライバシーポリシー' })).toHaveAttribute(
      'href',
      '/privacy',
    );
  });
});

// 2026-05-19 (docs/2026-05-19-roadmap-archive): 公開ページ (利用規約 / プライバシー
//   ポリシー) は未認証で到達可能であること + ドラフトマーカーが表示されることを検証
test.describe('@feature:public 利用規約 / プライバシーポリシー', () => {
  test('/terms にアクセスできドラフト表記が見える', async ({ page }) => {
    const response = await page.goto('/terms');
    expect(response?.status()).toBe(200);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: '利用規約', level: 1 })).toBeVisible();
    await expect(page.getByText('ドラフト版 - 法務監修待ち')).toBeVisible();
  });

  test('/privacy にアクセスできドラフト表記が見える', async ({ page }) => {
    const response = await page.goto('/privacy');
    expect(response?.status()).toBe(200);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'プライバシーポリシー', level: 1 })).toBeVisible();
    await expect(page.getByText('ドラフト版 - 法務監修待ち')).toBeVisible();
  });
});
