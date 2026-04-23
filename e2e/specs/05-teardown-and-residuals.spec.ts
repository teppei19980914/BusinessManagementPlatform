/**
 * E2E シナリオ Steps 9-12 (PR #95 / 段階導入 E 最終)。
 *
 * カバー範囲:
 *   Step 9:  UI からのログアウト (DashboardHeader のアカウントメニュー経由)
 *   Step 10: admin が一般ユーザを削除 (論理削除 + ProjectMember 物理削除、UI 経由)
 *   Step 11: admin がプロジェクトを削除 (削除ダイアログ経由、UI)
 *   Step 12: 残存検証 (削除後の /projects / /admin/users 一覧への不在を確認)
 *
 * 方針:
 *   前 PR 群で確立した sharedContext + ARIA 標準アサーションを踏襲。
 *   削除系は window.confirm / window.alert を使うので page.once('dialog') で自動承諾する。
 *
 * カバレッジ記録: docs/developer/E2E_COVERAGE.md に [x] でマッピング
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import {
  ensureInitialAdmin,
  ensureGeneralUser,
  cleanupByRunId,
  disconnectDb,
} from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';
import { createProjectViaApi, addProjectMemberViaApi } from '../fixtures/project';
import { snapshotStep } from '../fixtures/snapshot';

const ADMIN_EMAIL = `admin-pr95-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

const MEMBER_EMAIL = `${withRunId('pr95member')}@example.com`.toLowerCase();
const MEMBER_NAME = withRunId('PR95メンバー');
const MEMBER_PW = 'E2eMember!Pw_2026';

const PROJECT_NAME = withRunId('PR95プロジェクト');

let sharedContext: BrowserContext;
let sharedPage: Page;
let projectId = '';
let memberUserId = '';

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:teardown Steps 9-12 ログアウト + 削除 + 残存検証', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });
    memberUserId = await ensureGeneralUser(MEMBER_EMAIL, MEMBER_NAME, MEMBER_PW);

    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();

    await sharedPage.goto('/login');
    await sharedPage.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await sharedPage.getByLabel('パスワード').fill(ADMIN_PW);
    await sharedPage.getByRole('button', { name: 'ログイン' }).click();
    await waitForProjectsReady(sharedPage);

    // プロジェクト + メンバー追加
    const { id } = await createProjectViaApi(sharedPage, { name: PROJECT_NAME });
    projectId = id;
    await addProjectMemberViaApi(sharedPage, {
      projectId,
      userId: memberUserId,
      projectRole: 'member',
    });
  });

  test.afterAll(async () => {
    await sharedPage.close();
    await sharedContext.close();
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('Step 11: admin がプロジェクト詳細からプロジェクトを削除する', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');

    // 概要タブの右上「削除」ボタン (admin のみ / activeTab === 'overview')
    await page.getByRole('button', { name: '削除' }).first().click();

    // ダイアログが開く
    await expect(page.getByRole('heading', { name: 'プロジェクトを削除しますか？' })).toBeVisible({
      timeout: 10_000,
    });
    await snapshotStep(page, 'step-11-delete-dialog-open');

    // 資産チェックボックスは既定のまま (cascade 無効) で削除
    const deleteRes = page.waitForResponse(
      (r) => r.url().includes(`/api/projects/${projectId}`) && r.request().method() === 'DELETE',
    );
    await page.getByRole('button', { name: 'プロジェクトを削除する' }).click();
    const res = await deleteRes;
    expect(res.ok()).toBeTruthy();

    // 一覧画面へ遷移 (handleConfirmDelete 内で router.push('/projects'))
    await page.waitForURL('**/projects', { timeout: 10_000 });
    await page.waitForLoadState('networkidle');
  });

  test('Step 12a: 削除したプロジェクトが一覧に存在しないこと', async () => {
    const page = sharedPage;
    await page.goto('/projects');
    await page.waitForLoadState('networkidle');
    // 論理削除でも /projects は deletedAt IS NULL を絞るため表示対象外
    await expect(page.getByText(PROJECT_NAME)).toHaveCount(0, { timeout: 10_000 });
    await snapshotStep(page, 'step-12a-project-absent');
  });

  test('Step 10: admin が一般ユーザを削除する (UI 経由)', async () => {
    const page = sharedPage;
    await page.goto('/admin/users');
    await page.waitForLoadState('networkidle');

    // 対象ユーザ行をクリックして編集ダイアログを開く
    const row = page.locator('tr').filter({ hasText: MEMBER_EMAIL });
    await row.click();

    // 2 段階 confirm + 完了 alert を連続で自動応答
    page.on('dialog', (dialog) => dialog.accept());

    await page.getByRole('button', { name: 'このユーザを削除' }).click();
    // ダイアログ閉鎖 + 一覧更新を待つ
    await page.waitForLoadState('networkidle');
    await snapshotStep(page, 'step-10-user-deleted');
  });

  test('Step 12b: 削除したユーザが /admin/users 一覧に存在しないこと', async () => {
    const page = sharedPage;
    await page.goto('/admin/users');
    await page.waitForLoadState('networkidle');
    // 論理削除済ユーザは /admin/users から除外される (listUsers は deletedAt IS NULL)
    await expect(page.getByText(MEMBER_EMAIL)).toHaveCount(0, { timeout: 10_000 });
    await snapshotStep(page, 'step-12b-user-absent');
  });

  test('Step 9: admin がアカウントメニューからログアウトする', async () => {
    const page = sharedPage;
    await page.goto('/projects');
    await page.waitForLoadState('networkidle');

    // 画面右上のアカウントメニュー (aria-haspopup="menu" ボタン) を開く
    await page.getByRole('button', { expanded: false }).filter({ hasText: 'E2E 管理者' }).click();

    // ドロップダウン内「ログアウト」menuitem をクリック → /login へリダイレクト
    await page.getByRole('menuitem', { name: 'ログアウト' }).click();
    await page.waitForURL('**/login', { timeout: 10_000 });

    // ログイン画面の要素が見える = ログアウト成功
    await expect(page.getByLabel('メールアドレス')).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'step-9-logged-out');
  });
});
