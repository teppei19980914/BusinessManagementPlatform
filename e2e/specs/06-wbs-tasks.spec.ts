/**
 * E2E シナリオ: WBS 管理 (PR #96)
 *
 * カバー範囲:
 *   - /projects/[id]/tasks の WBS 管理画面が render される
 *   - Work Package (WP) + Activity (ACT) を API で作成、UI ツリー上に表示される
 *   - UI から task を削除 (confirm 承諾)
 *
 * 方針:
 *   - UI フォームは 10+ フィールドあり複雑なので **作成は API 経由** で軽量化
 *   - UI 側は「描画されているか」「削除操作が通るか」を検証
 *   - ドラッグ&ドロップは本プロダクトでは未実装 (drag lib 不使用) なので対象外
 *
 * 本プロダクト最複雑のクライアントコンポーネント (tasks-client.tsx) のため、
 * 本スコープでは happy path のみ。状態遷移 / 進捗更新 / CSV import-export は後続 PR。
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

const ADMIN_EMAIL = `admin-pr96-wbs-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

const MEMBER_EMAIL = `${withRunId('pr96wbsmember')}@example.com`.toLowerCase();
const MEMBER_NAME = withRunId('PR96メンバー');
const MEMBER_PW = 'E2eMember!Pw_2026';

const PROJECT_NAME = withRunId('PR96WBSプロジェクト');
const WP_NAME = withRunId('WorkPackage-root');
const ACT_NAME = withRunId('Activity-child');

let sharedContext: BrowserContext;
let sharedPage: Page;
let projectId = '';
let memberUserId = '';
let workPackageId = '';

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:project:wbs WBS 管理 (PR #96)', () => {
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

    const { id } = await createProjectViaApi(sharedPage, { name: PROJECT_NAME });
    projectId = id;
    // ACT の担当者候補として member を追加
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

  test('/tasks 画面が render され、WBS管理 見出しが表示される', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'WBS管理' })).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'wbs-empty');
  });

  test('Work Package を API で作成 → UI ツリーに表示される', async () => {
    const page = sharedPage;
    const res = await page.request.post(`/api/projects/${projectId}/tasks`, {
      data: {
        type: 'work_package',
        name: WP_NAME,
      },
    });
    expect(res.ok(), `WP create: ${await res.text()}`).toBeTruthy();
    workPackageId = (await res.json()).data.id;

    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');
    // 一覧行は table row にスコープ + .first() (LESSONS_LEARNED §4.11)
    await expect(
      page.locator('tr').filter({ hasText: WP_NAME }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'wbs-with-wp');
  });

  test('Activity を WP 配下に API で作成 → UI ツリーに表示される', async () => {
    const page = sharedPage;
    const today = new Date().toISOString().slice(0, 10);
    const in7 = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const res = await page.request.post(`/api/projects/${projectId}/tasks`, {
      data: {
        type: 'activity',
        parentTaskId: workPackageId,
        name: ACT_NAME,
        assigneeId: memberUserId,
        plannedStartDate: today,
        plannedEndDate: in7,
        plannedEffort: 8,
      },
    });
    expect(res.ok(), `ACT create: ${await res.text()}`).toBeTruthy();

    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');
    await expect(
      page.locator('tr').filter({ hasText: ACT_NAME }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'wbs-with-wp-and-act');
  });

  test('Activity を UI から削除できる (confirm 承諾)', async () => {
    const page = sharedPage;
    // /tasks ページが開いている前提 (直前 test の状態)
    page.once('dialog', (dialog) => dialog.accept());

    // 対象 ACT 行の aria-label="削除" ボタン
    const actRow = page.locator('tr').filter({ hasText: ACT_NAME });
    await actRow.getByRole('button', { name: '削除' }).click();

    await page.waitForLoadState('networkidle');
    await expect(page.locator('tr').filter({ hasText: ACT_NAME })).toHaveCount(0, {
      timeout: 10_000,
    });
    await snapshotStep(page, 'wbs-after-act-delete');
  });
});
