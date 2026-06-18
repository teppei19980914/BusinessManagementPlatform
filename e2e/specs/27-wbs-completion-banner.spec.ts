/**
 * E2E: WBS 完了バナー (v1.3.0 資産導線機能)
 *
 * 検証観点:
 *   1. プロジェクト内の ACT が未完了を含む間はバナーが出ない
 *   2. 全 ACT が completed/on_hold のみになるとバナーが表示される (実 PM/TL のみ)
 *   3. 実 PM/TL ではない一般メンバーには表示されない (ロールゲート)
 *   4. ×で閉じると当該セッションでは再表示されない (リロードしても維持)
 *   5. 別セッション (新規ログイン) では再表示される
 *
 * system-banner-bar (e2e/specs/21-system-banner.spec.ts) と同型の sessionStorage 破棄方式を
 * プロジェクト単位に適用したもの。
 *
 * 関連:
 *   - サービス: src/services/task.service.ts (getWbsCompletionBannerState)
 *   - storage: src/lib/wbs-completion-banner-dismiss-storage.ts
 *   - UI: src/components/wbs-completion-banner.tsx
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import {
  ensureInitialAdmin,
  ensureGeneralUser,
  cleanupByRunId,
  disconnectDb,
} from '../fixtures/db';
import { waitForProjectsReady, loginAsGeneral } from '../fixtures/auth';
import { createProjectViaApi, addProjectMemberViaApi } from '../fixtures/project';

const ADMIN_EMAIL = `admin-wbsbanner-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

const PMTL_EMAIL = `${withRunId('wbsbannerpmtl')}@example.com`.toLowerCase();
const PMTL_NAME = withRunId('WBS帯PMTL');
const PMTL_PW = 'E2eMember!Pw_2026';

const MEMBER_EMAIL = `${withRunId('wbsbannermember')}@example.com`.toLowerCase();
const MEMBER_NAME = withRunId('WBS帯一般メンバー');
const MEMBER_PW = 'E2eMember!Pw_2026';

const PROJECT_NAME = withRunId('WBS帯プロジェクト');
const ACT_NAME = withRunId('WBS帯Activity');
const BANNER_MESSAGE = '予定されているタスクがすべて完了しました。プロジェクトの振り返りは済んでいますか？';

let adminContext: BrowserContext;
let adminPage: Page;
let pmtlUserId = '';
let memberUserId = '';
let projectId = '';
let actId = '';

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:project:wbs-completion-banner WBS 完了バナー (v1.3.0)', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });
    pmtlUserId = await ensureGeneralUser(PMTL_EMAIL, PMTL_NAME, PMTL_PW);
    memberUserId = await ensureGeneralUser(MEMBER_EMAIL, MEMBER_NAME, MEMBER_PW);

    adminContext = await browser.newContext();
    adminPage = await adminContext.newPage();
    await adminPage.goto('/login');
    await adminPage.getByLabel('組織 ID').fill('default');
    await adminPage.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await adminPage.getByLabel('パスワード').fill(ADMIN_PW);
    await adminPage.getByRole('button', { name: 'ログイン', exact: true }).click();
    await waitForProjectsReady(adminPage);

    const { id } = await createProjectViaApi(adminPage, { name: PROJECT_NAME });
    projectId = id;
    await addProjectMemberViaApi(adminPage, { projectId, userId: pmtlUserId, projectRole: 'pm_tl' });
    // ロールゲート検証用: pm_tl ではない一般メンバーとして同じプロジェクトに参加させる
    await addProjectMemberViaApi(adminPage, { projectId, userId: memberUserId, projectRole: 'member' });

    const today = new Date().toISOString().slice(0, 10);
    const in7 = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const actRes = await adminPage.request.post(`/api/projects/${projectId}/tasks`, {
      data: {
        type: 'activity',
        name: ACT_NAME,
        assigneeId: pmtlUserId,
        plannedStartDate: today,
        plannedEndDate: in7,
        plannedEffort: 4,
      },
    });
    expect(actRes.ok(), `ACT create: ${await actRes.text()}`).toBeTruthy();
    actId = (await actRes.json()).data.id;
  });

  test.afterAll(async () => {
    await adminPage?.close().catch(() => undefined);
    await adminContext?.close().catch(() => undefined);
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('ACT が未完了 (not_started) の間はバナーが出ない', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAsGeneral(page, context, { email: PMTL_EMAIL, password: PMTL_PW });

    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('wbs-completion-banner')).toBeHidden();

    await page.close();
    await context.close();
  });

  test('全 ACT が completed になると実 PM/TL にバナーが表示される', async ({ browser }) => {
    const patchRes = await adminPage.request.patch(`/api/projects/${projectId}/tasks/${actId}`, {
      data: { status: 'completed', actualEffort: 1 },
    });
    expect(patchRes.ok(), `ACT complete: ${await patchRes.text()}`).toBeTruthy();

    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAsGeneral(page, context, { email: PMTL_EMAIL, password: PMTL_PW });

    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');
    const banner = page.getByTestId('wbs-completion-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText(BANNER_MESSAGE);

    await page.close();
    await context.close();
  });

  test('実 PM/TL ではない一般メンバーには表示されない (ロールゲート)', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAsGeneral(page, context, { email: MEMBER_EMAIL, password: MEMBER_PW });

    // beforeAll で projectRole='member' として参加済み (shouldShow=true でも pm_tl 以外には非表示)
    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('wbs-completion-banner')).toBeHidden();

    await page.close();
    await context.close();
  });

  test('×で閉じると当該セッションでは再表示されない (リロードしても維持)', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAsGeneral(page, context, { email: PMTL_EMAIL, password: PMTL_PW });

    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');
    const banner = page.getByTestId('wbs-completion-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });

    await banner.getByRole('button', { name: 'このお知らせを閉じる' }).click();
    await expect(banner).toBeHidden();

    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('wbs-completion-banner')).toBeHidden();

    await page.close();
    await context.close();
  });

  test('別セッション (新規ログイン) では再表示される', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAsGeneral(page, context, { email: PMTL_EMAIL, password: PMTL_PW });

    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('wbs-completion-banner')).toBeVisible({ timeout: 10_000 });

    await page.close();
    await context.close();
  });
});
