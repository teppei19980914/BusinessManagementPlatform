/**
 * 視覚回帰テスト - 認証系画面 (PR #90 基盤サンプル)。
 *
 * 対象: /login, /reset-password, /setup-password (token 不要な表示初期状態)
 *
 * ベースライン運用方針:
 *   - 初回実行時は baseline PNG が存在せず CI で fail するため、
 *     開発者ローカルで `pnpm test:e2e:update-snapshots` を実行し、
 *     `e2e/visual/auth-screens.spec.ts-snapshots/` 配下の PNG を commit する。
 *   - CI 上で baseline を自動生成する運用は採用しない
 *     (baseline は開発者環境 or Linux CI コンテナ内のフォント/レンダリング差異を
 *     吸収する必要があるため、将来的には CI Linux 環境で生成する方針)。
 *   - 以降の実行では pixel 差分 > 1% で fail
 *   - 意図した UI 変更で fail した場合は `pnpm test:e2e:update-snapshots` で再生成
 *
 * PR #90 基盤段階: baseline 未 commit のため test.skip で一時無効化。
 * PR #E で本格運用開始時に有効化する予定。
 *
 * カバレッジ記録: docs/E2E_COVERAGE.md 「認証系画面 (視覚回帰)」
 */

import { test, expect } from '@playwright/test';

// PR #90: baseline 未生成のため一時的に全 visual 回帰テストを skip。
// ローカルで `pnpm test:e2e:update-snapshots` 実行 → PNG commit → test.describe.skip を削除、
// の手順で PR E にて有効化予定。
test.describe.skip('@visual:auth 認証画面', () => {
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
