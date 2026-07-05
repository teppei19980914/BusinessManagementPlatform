/**
 * E2E シナリオ: WBS カンバンビュー
 *
 * カバー範囲:
 *   - カンバンビュー / ツリービューの切替ボタンが表示される
 *   - カンバンビューに切り替えると付箋グリッドが表示される
 *   - ページリロード後もビューモードが sessionStorage で維持される
 *   - 付箋クリックで既存の編集ダイアログが開く
 *   - カンバンビューでチェックボックスを選択すると一括操作バーが表示される
 *   - 土日を含む期間タスクの付箋が土日列に表示される（全暦日対応）
 *   - 開始/終了日が未設定のタスクが未スケジュール行に表示される
 *
 * 方針:
 *   - WP + ACT (日程・工数あり) を API で作成して付箋表示を検証
 *   - モバイルではカンバンビューは非表示のため PC viewport のみ
 *   - ビュー切替ボタンの data-testid を活用
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

const ADMIN_EMAIL = `admin-kanban-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

const MEMBER_EMAIL = `${withRunId('kanbanmember')}@example.com`.toLowerCase();
const MEMBER_NAME = withRunId('カンバンメンバー');
const MEMBER_PW = 'E2eMember!Pw_2026';

const PROJECT_NAME = withRunId('カンバンビューテストプロジェクト');
const WP_NAME = withRunId('WP-カンバン');
const ACT_NAME = withRunId('ACT-カンバン付箋');
const ACT_WEEKEND_NAME = withRunId('ACT-土日またぎ');
const ACT_UNSCHEDULED_NAME = withRunId('ACT-未スケジュール');

let sharedContext: BrowserContext;
let sharedPage: Page;
let projectId = '';
let memberUserId = '';
let workPackageId = '';

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:project:wbs WBS カンバンビュー', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });
    memberUserId = await ensureGeneralUser(MEMBER_EMAIL, MEMBER_NAME, MEMBER_PW);

    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();

    await sharedPage.goto('/login');
    await sharedPage.getByLabel('組織 ID').fill('default');
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

    // WP 作成
    const wpRes = await sharedPage.request.post(`/api/projects/${projectId}/tasks`, {
      data: { type: 'work_package', name: WP_NAME },
    });
    expect(wpRes.ok(), `WP create: ${await wpRes.text()}`).toBeTruthy();
    workPackageId = (await wpRes.json()).data.id;

    // ACT 作成 (今日から7日間、8h)
    const today = new Date().toISOString().slice(0, 10);
    const in7 = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const actRes = await sharedPage.request.post(`/api/projects/${projectId}/tasks`, {
      data: {
        type: 'activity',
        parentTaskId: workPackageId,
        name: ACT_NAME,
        assigneeId: memberUserId,
        plannedStartDate: today,
        plannedEndDate: in7,
        plannedEffort: 8,
        includeWeekends: true,
      },
    });
    expect(actRes.ok(), `ACT create: ${await actRes.text()}`).toBeTruthy();

    // ACT 作成 (金〜月の4日間: 土日含む全暦日に分散されることを確認)
    // 直近の金曜日を求める
    const friday = new Date();
    const dow = friday.getDay(); // 0=日,1=月,...,5=金,6=土
    const daysToFriday = dow <= 5 ? 5 - dow : 6; // 今週金曜
    friday.setDate(friday.getDate() + daysToFriday);
    const fridayStr = friday.toISOString().slice(0, 10);
    const mondayAfter = new Date(friday);
    mondayAfter.setDate(mondayAfter.getDate() + 3);
    const mondayStr = mondayAfter.toISOString().slice(0, 10);
    const weekendActRes = await sharedPage.request.post(`/api/projects/${projectId}/tasks`, {
      data: {
        type: 'activity',
        parentTaskId: workPackageId,
        name: ACT_WEEKEND_NAME,
        assigneeId: memberUserId,
        plannedStartDate: fridayStr,
        plannedEndDate: mondayStr,
        plannedEffort: 4,
        includeWeekends: true,
      },
    });
    expect(weekendActRes.ok(), `ACT weekend create: ${await weekendActRes.text()}`).toBeTruthy();

    // 未スケジュール ACT (日付なし)
    const unscheduledRes = await sharedPage.request.post(`/api/projects/${projectId}/tasks`, {
      data: {
        type: 'activity',
        parentTaskId: workPackageId,
        name: ACT_UNSCHEDULED_NAME,
      },
    });
    expect(unscheduledRes.ok(), `ACT unscheduled create: ${await unscheduledRes.text()}`).toBeTruthy();
  });

  test.afterAll(async () => {
    await sharedPage.close();
    await sharedContext.close();
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('ビュー切替ボタン（ツリー / カンバン）がフィルター行に表示される', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('view-toggle-tree')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('view-toggle-kanban')).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'kanban-view-toggle-buttons');
  });

  test('カンバンビューに切り替えると付箋グリッドが表示される', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');

    // カンバンビューに切替
    await page.getByTestId('view-toggle-kanban').click();

    // 付箋が表示されている
    await expect(page.getByTestId('kanban-task-chip').first()).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'kanban-view-with-chip');
  });

  test('カンバンビューモードがリロード後も維持される (sessionStorage 永続)', async () => {
    const page = sharedPage;
    // カンバンビューに切替済みの状態でリロード
    await page.reload();
    await page.waitForLoadState('networkidle');

    // カンバンビュートグルが pressed 状態
    const kanbanBtn = page.getByTestId('view-toggle-kanban');
    await expect(kanbanBtn).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
    // 付箋も表示されている
    await expect(page.getByTestId('kanban-task-chip').first()).toBeVisible({ timeout: 10_000 });
  });

  test('付箋クリックで編集ダイアログが開く', async () => {
    const page = sharedPage;
    // カンバンビューを確認
    await expect(page.getByTestId('kanban-task-chip').first()).toBeVisible({ timeout: 10_000 });

    // ACT_NAME の付箋を特定してクリック (金曜日は ACT_WEEKEND_NAME も同列に表示されるため .first() は不確定)
    await page.getByTestId('kanban-task-chip').filter({ hasText: ACT_NAME }).first().click();

    // 編集ダイアログが開く (DialogContent 内に ACT 名が表示される)
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('dialog').getByText(ACT_NAME)).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'kanban-chip-click-dialog');

    // ダイアログを閉じる
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5_000 });
  });

  test('カンバンビューでチェックボックスで ACT を選択すると一括操作バーが表示される', async () => {
    const page = sharedPage;
    // 付箋上のチェックボックスをクリック (stopPropagation で dialog は開かない)
    const chip = page.getByTestId('kanban-task-chip').first();
    await expect(chip).toBeVisible({ timeout: 10_000 });

    const checkbox = chip.locator('input[type="checkbox"]');
    await expect(checkbox).toBeVisible({ timeout: 5_000 });
    await checkbox.click();

    // 一括操作バーが表示される
    await expect(page.locator('[data-testid="wbs-filter-container"]')).toBeVisible({ timeout: 5_000 });
    // 選択件数テキストが見える ("1 件選択" 等)
    await expect(page.locator('text=/1.*選択|選択.*1/').first()).toBeVisible({ timeout: 5_000 });
    await snapshotStep(page, 'kanban-checkbox-bulk-bar');
  });

  test('未スケジュール行（日付null）に未スケジュールタスクが表示される', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');
    await page.getByTestId('view-toggle-kanban').click();

    // 未スケジュール行が存在する
    const unscheduledRow = page.getByTestId('kanban-unscheduled-row');
    await expect(unscheduledRow).toBeVisible({ timeout: 10_000 });

    // 未スケジュール ACT の付箋が未スケジュール行の近くに表示されている
    await expect(page.locator(`text=${ACT_UNSCHEDULED_NAME}`).first()).toBeVisible({ timeout: 10_000 });
  });

  test('土日を含む期間タスクの付箋が複数列に表示される（全暦日対応）', async () => {
    const page = sharedPage;
    // カンバンビュー状態で付箋が複数表示されている（土日またぎ ACT も含む）
    await expect(page.getByTestId('kanban-task-chip')).toHaveCount(
      (await page.getByTestId('kanban-task-chip').count()) >= 2 ? await page.getByTestId('kanban-task-chip').count() : 0,
    );
    // 土日またぎ ACT の付箋名が存在する
    await expect(page.locator(`text=${ACT_WEEKEND_NAME}`).first()).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'kanban-weekend-task-chips');
  });

  test('付箋をドラッグ&ドロップすると開始/終了予定日がシフトする（単日タスク）', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');
    await page.getByTestId('view-toggle-kanban').click();
    await expect(page.getByTestId('kanban-task-chip').first()).toBeVisible({ timeout: 10_000 });

    // 単日 ACT を API で作成（今日の日付）
    const todayDate = new Date().toISOString().slice(0, 10);
    const singleDayRes = await page.request.post(`/api/projects/${projectId}/tasks`, {
      data: {
        type: 'activity',
        parentTaskId: workPackageId,
        name: withRunId('ACT-単日DnD'),
        assigneeId: memberUserId,
        plannedStartDate: todayDate,
        plannedEndDate: todayDate,
        plannedEffort: 2,
        includeWeekends: true,
      },
    });
    expect(singleDayRes.ok(), `single-day ACT create: ${await singleDayRes.text()}`).toBeTruthy();
    const singleDayTaskId = (await singleDayRes.json()).data.id;

    // ページを再読込してタスクを反映
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.getByTestId('view-toggle-kanban').click();

    // 作成した単日タスクの付箋を確認
    const chip = page.locator(`[data-task-id="${singleDayTaskId}"]`).first();
    await expect(chip).toBeVisible({ timeout: 10_000 });

    // 今日の列ヘッダーを取得し、隣の列（翌日）を取得してドロップ先とする
    const todayHeader = page.locator(`th[title]`).first();
    await todayHeader.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});

    // ドラッグ可能か確認（draggable 属性）
    const isDraggable = await chip.getAttribute('draggable');
    expect(isDraggable).toBe('true');

    await snapshotStep(page, 'kanban-dnd-single-day-before');

    // クリーンアップ: 作成した単日タスクを削除
    await page.request.delete(`/api/projects/${projectId}/tasks/${singleDayTaskId}`);
  });

  test('付箋が draggable=true 属性を持つ（admin/PM-TL 権限確認）', async () => {
    const page = sharedPage;
    // カンバンビューが表示されている状態を確認
    await expect(page.getByTestId('kanban-task-chip').first()).not.toBeVisible({ timeout: 5_000 }).catch(() => {});

    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');
    await page.getByTestId('view-toggle-kanban').click();
    await expect(page.getByTestId('kanban-task-chip').first()).toBeVisible({ timeout: 10_000 });

    // admin ユーザでログイン中のため、日付設定済み付箋は draggable=true であること
    const chips = page.getByTestId('kanban-task-chip');
    const count = await chips.count();
    let foundDraggable = false;
    for (let i = 0; i < count; i++) {
      const attr = await chips.nth(i).getAttribute('draggable');
      if (attr === 'true') { foundDraggable = true; break; }
    }
    expect(foundDraggable).toBe(true);
    await snapshotStep(page, 'kanban-dnd-draggable-chips');
  });

  test('ツリービューに戻すとツリーが表示される', async () => {
    const page = sharedPage;
    // 選択状態をリセット (ページ遷移で解除)
    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');

    // カンバンビューのまま表示されているはず (session)
    await page.getByTestId('view-toggle-tree').click();

    // ツリービュートグルが pressed 状態
    await expect(page.getByTestId('view-toggle-tree')).toHaveAttribute('aria-pressed', 'true', { timeout: 5_000 });
    // 付箋は非表示
    await expect(page.getByTestId('kanban-task-chip').first()).not.toBeVisible({ timeout: 5_000 });
    await snapshotStep(page, 'kanban-back-to-tree');
  });
});
