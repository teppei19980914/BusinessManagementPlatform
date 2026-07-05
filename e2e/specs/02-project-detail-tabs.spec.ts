/**
 * E2E シナリオ Step 7 前半 (PR #93 / 段階導入 C, v1.5.0 改修)。
 *
 * カバー範囲:
 *   プロジェクト詳細画面の 2 階層タブが render すること、各タブ・サブタブの
 *   主要見出し/要素が表示されること。admin と project member (general) で権限差分を検証。
 *
 * v1.5.0 タブ構造 (親タブ → サブタブ):
 *   概要 / 見積もり (admin/pm_tl のみ) /
 *   進捗管理 → WBS管理 / 進捗確認 /
 *   資産 → リスク一覧 / 課題一覧 / 振り返り一覧 / ナレッジ一覧 /
 *   参考情報 (admin/pm_tl のみ) → 稼働分析 / 提案 /
 *   ツール / メンバー (admin/pm_tl のみ) / ステークホルダー (admin/pm_tl のみ)
 *
 * PC/Mobile 共通でサブタブ表示に統一 (旧 dropdown は廃止)。
 *
 * CRUD 検証ではなく render smoke に絞る (CRUD は後続 PR)。
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
    // ADR-0016 (2026-05-20): 組織 ID 必須化。ensureInitialAdmin は default-tenant に作成
    await sharedPage.getByLabel('組織 ID').fill('default');
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

  test('admin がプロジェクト詳細ページを開くと全親タブが表示される', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');

    // PR #93 hotfix 1: プロジェクト名は複数箇所に出現しうるため h2 + first() でユニーク化
    await expect(
      page.locator('h2').filter({ hasText: PROJECT_NAME }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // v1.5.0: PC/Mobile 共通で同じ親タブが表示される (dropdown 廃止)
    await expect(page.getByRole('tab', { name: '概要' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '見積もり' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '進捗管理' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '資産' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '参考情報' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'ツール' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'メンバー' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'ステークホルダー' })).toBeVisible();

    await snapshotStep(page, 'project-detail-all-tabs-admin');
  });

  test('進捗管理タブを開くとサブタブ (WBS管理/進捗確認) が表示される', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');

    await page.getByRole('tab', { name: '進捗管理' }).click();
    await expect(page.getByRole('tab', { name: '進捗管理' })).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });

    // サブタブが出現する
    await expect(page.getByRole('tab', { name: 'WBS管理' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '進捗確認' })).toBeVisible();

    // WBS管理サブタブが初期選択される
    await expect(page.getByRole('tab', { name: 'WBS管理' })).toHaveAttribute('aria-selected', 'true');

    // 進捗確認 (ガント) に切り替え
    await page.getByRole('tab', { name: '進捗確認' }).click();
    await expect(page.getByRole('tab', { name: '進捗確認' })).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });

    await snapshotStep(page, 'project-detail-progress-subtabs');
  });

  test('資産タブを開くとサブタブ (リスク/課題/振り返り/ナレッジ) が表示される', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');

    await page.getByRole('tab', { name: '資産' }).click();
    await expect(page.getByRole('tab', { name: '資産' })).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });

    // サブタブが出現する
    await expect(page.getByRole('tab', { name: 'リスク一覧' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '課題一覧' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '振り返り一覧' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'ナレッジ一覧' })).toBeVisible();

    // リスク一覧サブタブが初期選択される
    await expect(page.getByRole('tab', { name: 'リスク一覧' })).toHaveAttribute('aria-selected', 'true');

    // 各サブタブを順にクリックして aria-selected が遷移することを確認
    for (const name of ['課題一覧', '振り返り一覧', 'ナレッジ一覧']) {
      await page.getByRole('tab', { name }).click();
      await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
    }

    await snapshotStep(page, 'project-detail-assets-subtabs');
  });

  test('参考情報タブを開くとサブタブ (稼働分析/提案) が表示される (admin)', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');

    await page.getByRole('tab', { name: '参考情報' }).click();
    await expect(page.getByRole('tab', { name: '参考情報' })).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });

    // サブタブが出現する
    await expect(page.getByRole('tab', { name: '稼働分析' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '提案' })).toBeVisible();

    // 稼働分析サブタブが初期選択される
    await expect(page.getByRole('tab', { name: '稼働分析' })).toHaveAttribute('aria-selected', 'true');

    await snapshotStep(page, 'project-detail-reference-subtabs');
  });

  test('各親タブをクリックするとアクティブ切替が発生する (admin)', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');

    // 概要タブは初期表示 - プロジェクト情報フィールドの一部 (顧客名) が見える
    await expect(page.getByText('E2E 顧客').first()).toBeVisible({ timeout: 10_000 });

    // v1.5.0: PC/Mobile 共通の親タブ (dropdown 廃止)
    // タブ UI は @base-ui/react (aria-selected="true") を使用。
    const parentTabs = ['概要', '見積もり', '進捗管理', '資産', '参考情報', 'ツール', 'メンバー', 'ステークホルダー'];
    for (const name of parentTabs) {
      const tab = page.getByRole('tab', { name });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
    }

    await snapshotStep(page, 'project-detail-tab-switching');
  });

  test('メンバータブにメンバー一覧が表示される', async () => {
    const page = sharedPage;
    await page.getByRole('tab', { name: 'メンバー' }).click();
    // メンバー一覧も tbody tr + .first() でスコープ (LESSONS_LEARNED §4.11)
    await expect(
      page.locator('tbody tr').filter({ hasText: MEMBER_NAME }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'project-detail-members-tab');
  });

  test('general ユーザが参加プロジェクトを開くと admin 専用タブが非表示', async () => {
    const page = sharedPage;
    await loginAsGeneral(page, sharedContext, { email: MEMBER_EMAIL, password: MEMBER_PW });
    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');

    // v1.5.0: PC/Mobile 共通で member が見える親タブ
    await expect(page.getByRole('tab', { name: '概要' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '進捗管理' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '資産' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'ツール' })).toBeVisible();

    // admin/pm_tl 専用タブは表示されないこと
    await expect(page.getByRole('tab', { name: '見積もり' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: '参考情報' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'メンバー' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'ステークホルダー' })).toHaveCount(0);

    // member が進捗管理タブを開くとサブタブが見えること
    await page.getByRole('tab', { name: '進捗管理' }).click();
    await expect(page.getByRole('tab', { name: 'WBS管理' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('tab', { name: '進捗確認' })).toBeVisible();

    await snapshotStep(page, 'project-detail-general-member-view');
  });
});
