/**
 * E2E シナリオ: ガントチャート (PR #96)
 *
 * カバー範囲:
 *   - /projects/[id]/gantt 画面が render される
 *   - WBS に Activity を API で登録すると、ガントに時系列で描画される
 *   - タスク名フィルタ (担当者 / 状況) コントロールが表示される
 *
 * 方針:
 *   ガントチャート描画そのもの (日付グリッド + バー位置精度) は検証困難。
 *   「Activity の名前がガント画面に現れるか」で描画の疎通確認に絞る。
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

const ADMIN_EMAIL = `admin-pr96-gantt-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

const MEMBER_EMAIL = `${withRunId('pr96ganttmember')}@example.com`.toLowerCase();
const MEMBER_NAME = withRunId('PR96ガントメンバー');
const MEMBER_PW = 'E2eMember!Pw_2026';

const PROJECT_NAME = withRunId('PR96ガントプロジェクト');
const ACT_NAME = withRunId('ガント検証ACT');

let sharedContext: BrowserContext;
let sharedPage: Page;
let projectId = '';
let memberUserId = '';

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:project:gantt ガントチャート (PR #96)', () => {
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
    await addProjectMemberViaApi(sharedPage, {
      projectId,
      userId: memberUserId,
      projectRole: 'member',
    });

    // API で Activity を 1 本作成 (ガント描画対象を用意)
    const today = new Date().toISOString().slice(0, 10);
    const in14 = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await sharedPage.request.post(`/api/projects/${projectId}/tasks`, {
      data: {
        type: 'activity',
        name: ACT_NAME,
        assigneeId: memberUserId,
        plannedStartDate: today,
        plannedEndDate: in14,
        plannedEffort: 16,
      },
    });
    if (!res.ok()) throw new Error(`ACT seed failed: ${res.status()} ${await res.text()}`);
  });

  test.afterAll(async () => {
    await sharedPage.close();
    await sharedContext.close();
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('/gantt 画面が render され、ガントチャート見出しが表示される', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}/gantt`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'ガントチャート' })).toBeVisible({
      timeout: 10_000,
    });
    await snapshotStep(page, 'gantt-rendered');
  });

  test('登録済の Activity 名がガント画面に表示される', async () => {
    const page = sharedPage;
    // ガントは task 名を縦列に描画する。LESSONS_LEARNED §4.11 で一意化
    await expect(
      page.locator('tr, div').filter({ hasText: ACT_NAME }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('担当者フィルタと状況フィルタの UI コントロールが表示される', async () => {
    const page = sharedPage;
    // MultiSelectFilter のラベル近傍にボタンがある。role='button' でフィルタトリガを確認
    await expect(page.getByText('担当者', { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText('状況', { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
    await snapshotStep(page, 'gantt-filters-visible');
  });
});
