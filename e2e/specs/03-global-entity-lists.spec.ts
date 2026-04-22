/**
 * E2E シナリオ Step 7 後半 (PR #93 / 段階導入 C)。
 *
 * カバー範囲:
 *   全ユーザ横断の 4 つの一覧画面 (全リスク / 全課題 / 全振り返り / 全ナレッジ) が
 *   正しく render されること、見出しとテーブル骨格が表示されること。
 *
 * CRUD は各プロジェクト配下の entity スコープで行うため、ここでは「一覧画面が開ける」
 * ことを smoke 検証する (PR #60 で admin 権限での全横断表示として分離された 4 画面)。
 *
 * コンテキスト共有: PR #92 で確立した sharedContext パターンを踏襲。
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID } from '../fixtures/run-id';
import { ensureInitialAdmin, cleanupByRunId, disconnectDb } from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';
import { snapshotStep } from '../fixtures/snapshot';

const ADMIN_EMAIL = `admin-pr93-lists-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

let sharedContext: BrowserContext;
let sharedPage: Page;

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:project:global-lists Step 7 全横断一覧', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });

    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();

    // admin UI ログイン (MFA 無し)
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

  test('全リスク画面 (/risks) が表示される', async () => {
    const page = sharedPage;
    await page.goto('/risks');
    await page.waitForLoadState('networkidle');
    // page.tsx の `<h2 className="text-xl font-semibold">全リスク</h2>` は実 h2
    await expect(page.getByRole('heading', { name: '全リスク' })).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'global-risks-list');
  });

  test('全課題画面 (/issues) が表示される', async () => {
    const page = sharedPage;
    await page.goto('/issues');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: '全課題' })).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'global-issues-list');
  });

  test('全振り返り画面 (/retrospectives) が表示される', async () => {
    const page = sharedPage;
    await page.goto('/retrospectives');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: '全振り返り' })).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'global-retrospectives-list');
  });

  test('全ナレッジ画面 (/knowledge) が表示される', async () => {
    const page = sharedPage;
    await page.goto('/knowledge');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: '全ナレッジ' })).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'global-knowledge-list');
  });
});
