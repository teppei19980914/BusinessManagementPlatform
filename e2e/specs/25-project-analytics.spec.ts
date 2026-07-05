/**
 * E2E: 稼働分析サブタブ (feat/project-analytics-tab / v1.2.0, v1.5.0 タブ構造改修)
 *
 * カバー範囲:
 *   プロジェクト詳細画面の「参考情報」→「稼働分析」サブタブの表示制御と描画を検証する。
 *   - admin / pm_tl: 参考情報タブが表示され、稼働分析サブタブで予実カーブが描画される。
 *     ツールバーのチップで残りパネルを表示でき、対象期間 (プリセット/カスタム) を
 *     操作できる (render + トグル smoke。集計の正しさは
 *     src/services/analytics.service.test.ts、期間フィルタは同 + analytics-range.test.ts、
 *     認可は route.test.ts で担保)
 *   - member: 参考情報タブは非表示 (PM/PL + admin のみ)
 *
 * 方針:
 *   既存 02-project-detail-tabs.spec.ts と同様の sharedContext パターンを踏襲。
 *   CRUD 検証ではなく render smoke に絞る (タブ→API→描画の経路が通ることの確認)。
 *
 * v1.5.0 変更: PC/Mobile 共通でサブタブ表示に統一 (旧「資産」プルダウン廃止)。
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

const ADMIN_EMAIL = `admin-analytics-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

const PM_EMAIL = `${withRunId('analyticspm')}@example.com`.toLowerCase();
const PM_NAME = withRunId('分析PM');
const PM_PW = 'E2ePm!Pw_2026';

const MEMBER_EMAIL = `${withRunId('analyticsmember')}@example.com`.toLowerCase();
const MEMBER_NAME = withRunId('分析メンバー');
const MEMBER_PW = 'E2eMember!Pw_2026';

const PROJECT_NAME = withRunId('分析プロジェクト');

let sharedContext: BrowserContext;
let sharedPage: Page;
let projectId = '';
let pmUserId = '';
let memberUserId = '';

test.describe.configure({ mode: 'serial', retries: 0 });

/** 稼働分析サブタブを開く (「参考情報」親タブ→「稼働分析」サブタブの 2 ステップ)。PC/Mobile 共通。 */
async function openAnalyticsTab(page: Page) {
  await page.getByRole('tab', { name: '参考情報' }).click();
  await page.getByRole('tab', { name: '稼働分析' }).click();
}

// 各パネルのタイトル (heading とツールバーのチップ button に同じ文字列が使われる)。
const PANEL_TITLES = {
  wbs: '進捗の遅れ・先行',
  throughput: '消化ペースと効率',
  variance: '見積の精度（予実差）',
  workload: '作業量の偏り',
  capacity: '日別の負荷（8h超）',
} as const;

/**
 * 稼働分析サブタブを開いた直後の検証。
 *   - 初期は予実カーブ 1 枚のみ表示 (見づらさ解消のため。残り 4 枚は heading 非表示)。
 *   - ツールバーのチップ (button) で他パネルを表示でき、heading が現れることを確認。
 * チップは button、パネル見出しは heading のため role で区別する
 * (getByText だとチップ文字列に当たって誤検知するため使わない)。
 */
async function expectAnalyticsRendered(page: Page) {
  // 初期表示: 予実カーブの見出し + 本日サマリ (fetch→build→render が通った証拠)。
  await expect(page.getByRole('heading', { name: PANEL_TITLES.wbs })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('本日時点')).toBeVisible({ timeout: 10_000 });
  // 残りパネルの見出しは初期では出ていない (チップは button なので heading には一致しない)。
  await expect(page.getByRole('heading', { name: PANEL_TITLES.workload })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: PANEL_TITLES.capacity })).toHaveCount(0);

  // チップで残り 4 枚を表示する。
  for (const name of [
    PANEL_TITLES.throughput,
    PANEL_TITLES.variance,
    PANEL_TITLES.workload,
    PANEL_TITLES.capacity,
  ]) {
    await page.getByRole('button', { name }).click();
  }
  for (const name of Object.values(PANEL_TITLES)) {
    await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 10_000 });
  }
}

test.describe('@feature:project:analytics 稼働分析サブタブ', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });
    pmUserId = await ensureGeneralUser(PM_EMAIL, PM_NAME, PM_PW);
    memberUserId = await ensureGeneralUser(MEMBER_EMAIL, MEMBER_NAME, MEMBER_PW);

    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();

    // admin UI ログイン
    await sharedPage.goto('/login');
    await sharedPage.getByLabel('組織 ID').fill('default');
    await sharedPage.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await sharedPage.getByLabel('パスワード').fill(ADMIN_PW);
    await sharedPage.getByRole('button', { name: 'ログイン' }).click();
    await waitForProjectsReady(sharedPage);

    // プロジェクト作成 + PM/TL・メンバー追加 (API 経由)
    const { id } = await createProjectViaApi(sharedPage, { name: PROJECT_NAME });
    projectId = id;
    await addProjectMemberViaApi(sharedPage, { projectId, userId: pmUserId, projectRole: 'pm_tl' });
    await addProjectMemberViaApi(sharedPage, { projectId, userId: memberUserId, projectRole: 'member' });
  });

  test.afterAll(async () => {
    // beforeAll が途中失敗した場合 (例: ブラウザ未インストール) は sharedPage/sharedContext が
    // 未定義になりうるため、存在チェックしてから close する (二次的な TypeError を防ぐ)。
    if (sharedPage) await sharedPage.close();
    if (sharedContext) await sharedContext.close();
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('admin: 参考情報タブ→稼働分析サブタブで予実カーブが描画される', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('tab', { name: '参考情報' })).toBeVisible();

    await openAnalyticsTab(page);
    await expectAnalyticsRendered(page);

    // 対象期間: プリセット切替 + カスタムで日付入力が現れることを確認 (smoke)。
    await page.getByRole('button', { name: '直近3ヶ月' }).click();
    await expect(page.getByRole('button', { name: '直近3ヶ月' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // 期間を効かせると、作業負担パネルに「期間の影響を受けない」注記が出る。
    await expect(page.getByText('スナップショットのため')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'カスタム' }).click();
    await expect(page.getByLabel('開始日')).toBeVisible();
    await expect(page.getByLabel('終了日')).toBeVisible();

    await snapshotStep(page, 'project-analytics-admin');
  });

  test('pm_tl: 参考情報タブ→稼働分析サブタブで予実カーブが描画される', async () => {
    const page = sharedPage;
    await loginAsGeneral(page, sharedContext, { email: PM_EMAIL, password: PM_PW });
    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('tab', { name: '参考情報' })).toBeVisible();

    await openAnalyticsTab(page);
    await expectAnalyticsRendered(page);
    await snapshotStep(page, 'project-analytics-pmtl');
  });

  test('member: 参考情報タブは非表示 (PM/PL + admin のみ)', async () => {
    const page = sharedPage;
    await loginAsGeneral(page, sharedContext, { email: MEMBER_EMAIL, password: MEMBER_PW });
    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');

    // 概要は見えるが、参考情報タブ (role=tab) はロールゲートで一切 render されない
    await expect(page.getByRole('tab', { name: '概要' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '参考情報' })).toHaveCount(0);
    await snapshotStep(page, 'project-analytics-member-hidden');
  });
});
