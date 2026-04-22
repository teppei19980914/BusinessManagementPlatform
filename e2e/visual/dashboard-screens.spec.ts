/**
 * 視覚回帰テスト - ダッシュボード主要画面 (PR #95 で雛形追加、baseline 未 commit)。
 *
 * 対象: /projects (プロジェクト一覧) / /settings (設定画面、10 テーマ対応予定)
 *
 * 現状: skip (baseline PNG 未生成)
 *
 * 有効化手順 (次担当者向け):
 *   1. CI (Linux) の playwright image 内で `pnpm test:e2e:update-snapshots` を実行
 *      (フォント/アンチエイリアス差異を吸収するため Windows ローカルでは NG)
 *   2. 生成された `e2e/visual/dashboard-screens.spec.ts-snapshots/*.png` を git commit
 *   3. 本ファイルの `test.describe.skip` を `test.describe` に変更 → merge
 *
 * 10 テーマ × 主要画面のマトリクス拡張プラン (未実装):
 *   - /projects × 10 themes = 10 PNG
 *   - /projects/[id] 概要タブ × 10 themes = 10 PNG
 *   - /settings × 10 themes = 10 PNG
 *   合計 30 baselines。実装時は `THEMES` 定数から theme を parametrize してループ化。
 *
 * カバレッジ記録: docs/E2E_COVERAGE.md の「視覚回帰対象画面」
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID } from '../fixtures/run-id';
import { ensureInitialAdmin, cleanupByRunId, disconnectDb } from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';

const ADMIN_EMAIL = `admin-visual-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

let sharedContext: BrowserContext;
let sharedPage: Page;

test.describe.configure({ mode: 'serial' });

test.describe.skip('@visual:dashboard ダッシュボード主要画面 (baseline 未 commit)', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });

    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();

    await sharedPage.goto('/login');
    await sharedPage.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await sharedPage.getByLabel('パスワード').fill(ADMIN_PW);
    await sharedPage.getByRole('button', { name: 'ログイン' }).click();
    await waitForProjectsReady(sharedPage);
  });

  test.afterAll(async () => {
    await sharedPage.close();
    await sharedContext.close();
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('プロジェクト一覧 初期表示 (light テーマ)', async () => {
    const page = sharedPage;
    await page.goto('/projects');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot('projects-light.png', { fullPage: true });
  });

  test('設定画面 初期表示 (light テーマ)', async () => {
    const page = sharedPage;
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot('settings-light.png', { fullPage: true });
  });
});
