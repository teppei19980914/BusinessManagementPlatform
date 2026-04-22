/**
 * 視覚回帰テスト - 認証系画面 (PR #90 基盤サンプル)。
 *
 * 対象: /login, /reset-password, /setup-password (token 不要な表示初期状態)
 *
 * ベースライン運用方針:
 *   - 最初の撮影時は自動的にベースラインが生成される
 *   - 以降の実行では pixel 差分 > 1% で fail
 *   - 意図した UI 変更で fail した場合は開発者ローカルで
 *     `pnpm test:e2e:update-snapshots` を実行してスナップショットを更新し、
 *     通常の git commit として PR に含める (PR #90 で方針合意)
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
