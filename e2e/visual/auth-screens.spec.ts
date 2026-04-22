/**
 * 視覚回帰テスト - 認証系画面 (PR #90 基盤 → PR #96 で有効化)。
 *
 * 対象: /login, /reset-password, /setup-password (token 不要な表示初期状態)
 *
 * ベースライン運用:
 *   - 初回実行時は baseline PNG が未生成で CI が fail する
 *   - **初期 baseline の生成は `.github/workflows/e2e-visual-baseline.yml` の
 *     workflow_dispatch をトリガする** (Linux CI 環境のフォント/レンダリングを
 *     再現するため、Windows/macOS ローカルでは使わない)
 *   - 生成後は pixel 差分 > 1% で fail (playwright.config.ts 参照)
 *   - 意図した UI 変更で fail した場合も同 workflow で再生成
 *
 * カバレッジ記録: docs/E2E_COVERAGE.md 「認証系画面 (視覚回帰)」
 */

import { test, expect } from '@playwright/test';

test.describe('@visual:auth 認証画面', () => {
  test('ログイン画面 初期表示', async ({ page }) => {
    await page.goto('/login');
    // DOM が安定するまで少し待つ (SSR 差分吸収)
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot('login.png', {
      fullPage: true,
    });
  });

  test('パスワードリセット画面 初期表示', async ({ page }) => {
    await page.goto('/reset-password');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot('reset-password.png', {
      fullPage: true,
    });
  });
});
