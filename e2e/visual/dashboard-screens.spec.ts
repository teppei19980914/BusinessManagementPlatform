/**
 * 視覚回帰テスト - ダッシュボード主要画面 (PR #95 雛形 → PR #96 で有効化)。
 *
 * 対象: /projects / /settings / /projects/[id] 概要タブ (admin light テーマ)
 *
 * ベースライン運用:
 *   - baseline PNG は `.github/workflows/e2e-visual-baseline.yml` の
 *     workflow_dispatch で生成・自動 commit される
 *   - 初回実行 or UI 変更時は同 workflow を手動トリガ
 *
 * 10 テーマ × 主要画面のマトリクス:
 *   settings-themes.spec.ts (別ファイル) で 10 テーマ × /settings を網羅。
 *   本ファイルは light テーマでのダッシュボード骨格検証に集中。
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import { ensureInitialAdmin, cleanupByRunId, disconnectDb } from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';
import { createProjectViaApi } from '../fixtures/project';

const ADMIN_EMAIL = `admin-visual-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';
const PROJECT_NAME = withRunId('VisualProject');

let sharedContext: BrowserContext;
let sharedPage: Page;
let projectId = '';

test.describe.configure({ mode: 'serial' });

test.describe('@visual:dashboard ダッシュボード主要画面', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });

    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();

    await sharedPage.goto('/login');
    await sharedPage.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await sharedPage.getByLabel('パスワード').fill(ADMIN_PW);
    await sharedPage.getByRole('button', { name: 'ログイン' }).click();
    await waitForProjectsReady(sharedPage);

    const { id } = await createProjectViaApi(sharedPage, { name: PROJECT_NAME });
    projectId = id;
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
    // マスクで実行ごと変動する部分 (RUN_ID 由来の名前) を固定
    await expect(page).toHaveScreenshot('projects-light.png', {
      fullPage: true,
      mask: [page.locator('tbody tr')],
    });
  });

  test('設定画面 初期表示 (light テーマ)', async () => {
    const page = sharedPage;
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot('settings-light.png', { fullPage: true });
  });

  test('プロジェクト詳細 概要タブ 初期表示 (light テーマ)', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');
    // 見出し (RUN_ID 含むプロジェクト名) を mask。構造ベースの比較にする
    await expect(page).toHaveScreenshot('project-detail-light.png', {
      fullPage: true,
      mask: [page.locator('h2').first()],
    });
  });
});
