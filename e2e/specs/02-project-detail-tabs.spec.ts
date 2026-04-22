/**
 * E2E シナリオ Step 7 前半 (PR #93 / 段階導入 C)。
 *
 * カバー範囲:
 *   プロジェクト詳細画面の全 10 タブが render すること、各タブの主要見出し/要素が
 *   表示されること。admin と project member (general) で権限差分の要点を検証する。
 *
 * 対象タブ (Tabs: Radix UI, role='tab' / role='tabpanel'):
 *   概要 / 見積もり (admin のみ) / WBS管理 / ガント /
 *   リスク一覧 / 課題一覧 / 振り返り一覧 / ナレッジ一覧 /
 *   参考 / メンバー (admin/pm_tl のみ)
 *
 * CRUD 検証ではなく render smoke に絞る (CRUD は後続 PR)。
 *
 * コンテキスト共有: PR #92 で確立した sharedContext パターンを踏襲。
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import {
  ensureInitialAdmin,
  ensureGeneralUser,
  cleanupByRunId,
  disconnectDb,
} from '../fixtures/db';
import { loginAsGeneral, waitForProjectsReady } from '../fixtures/auth';
import { createProjectViaApi, addProjectMemberViaApi } from '../fixtures/project';
import { snapshotStep } from '../fixtures/snapshot';

const ADMIN_EMAIL = `admin-pr93-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

const MEMBER_EMAIL = `${withRunId('pr93member')}@example.com`.toLowerCase();
const MEMBER_NAME = withRunId('PR93メンバー');
const MEMBER_PW = 'E2eMember!Pw_2026';

const PROJECT_NAME = withRunId('PR93プロジェクト');

let sharedContext: BrowserContext;
let sharedPage: Page;
let projectId = '';
let memberUserId = '';

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:project:detail Step 7 タブ render', () => {
  test.beforeAll(async ({ browser }) => {
    // admin / general をシード済みで作成 (forcePasswordChange=false、MFA 無し)
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });
    memberUserId = await ensureGeneralUser(MEMBER_EMAIL, MEMBER_NAME, MEMBER_PW);

    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();

    // admin UI ログイン (MFA 無し)
    await sharedPage.goto('/login');
    await sharedPage.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await sharedPage.getByLabel('パスワード').fill(ADMIN_PW);
    await sharedPage.getByRole('button', { name: 'ログイン' }).click();
    await waitForProjectsReady(sharedPage);

    // プロジェクト作成 + メンバー追加 (API 経由)
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

  test('admin がプロジェクト詳細ページを開くと全タブが表示される', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');

    // PR #93 hotfix 1: プロジェクト名は場合によって複数箇所に出現することがある
    // (hydration 過渡状態や状態バッジ近傍の反復表示など)。strict mode 違反を避けるため
    // `<h2>` 要素に限定して first() でユニーク化する。タブ一覧の可視性検証が本テストの核心で、
    // 名称の一意性検証はここでの責務外。
    await expect(
      page.locator('h2').filter({ hasText: PROJECT_NAME }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Radix UI Tabs は role='tab' を付与する
    await expect(page.getByRole('tab', { name: '概要' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '見積もり' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'WBS管理' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'ガント' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'リスク一覧' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '課題一覧' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '振り返り一覧' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'ナレッジ一覧' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '参考' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'メンバー' })).toBeVisible();
    await snapshotStep(page, 'project-detail-all-tabs-admin');
  });

  test('各タブをクリックするとアクティブ切替が発生する (admin)', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');

    // 概要タブは初期表示 - プロジェクト情報フィールドの一部 (顧客名) が見える
    await expect(page.getByText('E2E 顧客').first()).toBeVisible({ timeout: 10_000 });

    // タブ UI は @base-ui/react (data-active="" / aria-selected="true") を使用。
    // ライブラリ固有の data 属性ではなく、W3C ARIA 標準の aria-selected で判定する
    // (Radix UI の data-state="active" とは異なるため、過去に Radix 想定で書いて
    // 失敗した → PR #93 hotfix 3)。
    const tabNames = [
      '概要', '見積もり', 'WBS管理', 'ガント',
      'リスク一覧', '課題一覧', '振り返り一覧', 'ナレッジ一覧', '参考',
    ];
    for (const name of tabNames) {
      const tab = page.getByRole('tab', { name });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
    }

    // メンバータブは固有の UI 検証: 追加済メンバーが一覧に表示される
    await page.getByRole('tab', { name: 'メンバー' }).click();
    // メンバー一覧も tbody tr + .first() でスコープ (LESSONS_LEARNED §4.11)
    await expect(
      page.locator('tbody tr').filter({ hasText: MEMBER_NAME }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'project-detail-members-tab');
  });

  test('general ユーザが参加プロジェクトを開くと 見積もり/メンバー タブが非表示', async () => {
    const page = sharedPage;
    await loginAsGeneral(page, sharedContext, { email: MEMBER_EMAIL, password: MEMBER_PW });
    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');

    // member ロールは project:read 範囲のタブのみ表示される
    await expect(page.getByRole('tab', { name: '概要' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'WBS管理' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'ガント' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'リスク一覧' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '課題一覧' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '振り返り一覧' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'ナレッジ一覧' })).toBeVisible();

    // admin 専用のタブは表示されないこと
    await expect(page.getByRole('tab', { name: '見積もり' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'メンバー' })).toHaveCount(0);
    await snapshotStep(page, 'project-detail-general-member-view');
  });
});
