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

  test('/tasks 画面が render される (タブ active 確認)', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');
    // Phase A 要件 6 (2026-04-28): WBS管理 h2 タイトル削除に伴い、ボタンで render 検証していた。
    // 2026-04-30 (Task 1): Gantt は独立タブ化、トグルボタンは廃止。代わりに WBS タブ固有の
    //   「エクスポート」ボタンで render 検証する (admin/PM/TL に表示、空 WBS でも可視)。
    await expect(page.getByRole('button', { name: 'エクスポート' })).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'wbs-empty');
  });

  /**
   * fix/wbs-filter-regression: PR #128a-2 のモバイル対応で `<details className="md:open:">`
   * という壊れた Tailwind 記述を入れたため、PC でフィルタ (担当者 + 状況) が常時折りたたまれて
   * 表示されない degression が発生していた。再発防止として PC viewport で
   * フィルタ要素の可視性をチェックする回帰テストを追加。
   *
   * チェック内容:
   *   - 担当者ラベルの MultiSelectFilter ボタンが PC viewport で見える
   *   - 状況ラベルの MultiSelectFilter ボタンが PC viewport で見える
   *
   * モバイル (chromium-mobile) では本 spec が testIgnore 対象 (E2E_LESSONS_LEARNED §4.37)
   * のため PC のみで実行される。
   */
  test('WBS フィルタ (担当者 / 状況) が PC viewport で常時表示される (regression: PR #128a-2 で破壊された PC 表示)', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');
    // MultiSelectFilter は <button>{label}: ...</button> を render するため、
    // ボタンの accessible name を「担当者:」「状況:」prefix で部分一致させる
    await expect(page.getByRole('button', { name: /^担当者:/ })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /^状況:/ })).toBeVisible({ timeout: 10_000 });
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

    // WBS ツリーは WP を初期 collapsed 表示し、子 ACT は DOM から除外される
    // (tasks-client.tsx L297: `!isCollapsed && task.children?.map(...)`)。
    // ACT を検証する前に WP 行の展開トグル `▶` をクリックする。
    //
    // PR #96 hotfix 4 で tasks-client.tsx の展開ボタンに aria-label を追加
    // (Gantt 側と一貫化)。これにより getByRole('button', { name: ... }) で拾える。
    // 詳細は LESSONS_LEARNED §4.16 参照。
    const wpRow = page.locator('tr').filter({ hasText: WP_NAME });
    await wpRow.getByRole('button', { name: /展開|折りたたみ/ }).click();

    await expect(
      page.locator('tr').filter({ hasText: ACT_NAME }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'wbs-with-wp-and-act');
  });

  test('Activity を UI から削除できる (confirm 承諾)', async () => {
    const page = sharedPage;
    // /tasks ページが開いている前提 (直前 test の状態)

    // LESSONS §4.20/§4.26: 削除 click は router.refresh() の fire-and-forget と
    // dialog 承諾非同期で race する。DELETE API を click **前**に予約 → await、
    // 続けて page.reload で DB 真の状態を強制取得してから count 0 を assert する。
    // page.once('dialog') は click より前に登録しておく必要がある (alert/confirm は同期的 + microtask)。
    const deleteRes = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/projects/${projectId}/tasks/`)
        && r.request().method() === 'DELETE',
    );
    page.once('dialog', (dialog) => dialog.accept());

    // 対象 ACT 行の aria-label="削除" ボタン
    const actRow = page.locator('tr').filter({ hasText: ACT_NAME });
    await actRow.getByRole('button', { name: '削除' }).click();

    const res = await deleteRes;
    expect(res.ok(), `Activity DELETE failed: ${res.status()}`).toBeTruthy();

    // DB は更新済み。router.refresh() race を回避して UI を DB 真状態に強制同期。
    await page.reload({ waitUntil: 'networkidle' });

    await expect(page.locator('tr').filter({ hasText: ACT_NAME })).toHaveCount(0, {
      timeout: 10_000,
    });
    await snapshotStep(page, 'wbs-after-act-delete');
  });
});
