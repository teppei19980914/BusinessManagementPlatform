/**
 * 視覚回帰テスト - 顧客管理画面 (PR #111-2)
 *
 * 対象:
 *   - /customers/[id] 詳細画面 (admin light テーマ) のみ
 *
 * 設計判断:
 *   - /customers 一覧画面は **LESSONS §4.15 対策 a** に従い視覚回帰から除外。
 *     並列テストで他 spec が作成した顧客行が残存し、tbody 行数差 → mask 領域の
 *     座標がズレて pixel diff 20% で常時 fail するため (PR #111-2 hotfix / §4.31)。
 *   - /customers/[id] 詳細画面は単一顧客スコープ + 紐付プロジェクト 0 件で
 *     決定的になるため、§4.15 対策 b (データ固定) が有効。
 *     - 顧客名 (RUN_ID 含む) は h2 mask で除外
 *     - 紐付プロジェクト tbody は常に「ありません」空 state 1 行 → mask 不要だが
 *       保険で mask しておく
 *
 * ベースライン運用:
 *   - baseline PNG は `.github/workflows/e2e-visual-baseline.yml` で生成・自動 commit
 *   - UI 変更時は `[gen-visual]` commit で再生成
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import {
  ensureInitialAdmin,
  cleanupByRunId,
  disconnectDb,
} from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';
import { createCustomerViaApi } from '../fixtures/project';

const ADMIN_EMAIL = `admin-visual-customers-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';
const CUSTOMER_NAME = withRunId('VisualCustomer');

let sharedContext: BrowserContext;
let sharedPage: Page;
let customerId = '';

test.describe.configure({ mode: 'serial' });

test.describe('@visual:customers 顧客管理画面', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });

    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();

    await sharedPage.goto('/login');
    await sharedPage.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await sharedPage.getByLabel('パスワード').fill(ADMIN_PW);
    await sharedPage.getByRole('button', { name: 'ログイン' }).click();
    await waitForProjectsReady(sharedPage);

    const { id } = await createCustomerViaApi(sharedPage, {
      name: CUSTOMER_NAME,
      department: '情報システム部',
    });
    customerId = id;
  });

  test.afterAll(async () => {
    await sharedPage.close();
    await sharedContext.close();
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  // /customers 一覧画面の視覚回帰は LESSONS §4.15 / §4.31 により対象外。
  // 理由: 並列テストで他 spec の顧客行が DB に残存し、tbody 行数が変動するため
  // mask 境界座標が baseline と一致せず常に pixel diff で fail する。主要な
  // テーマ回帰は settings-themes.spec.ts の 10 テーママトリクスでカバー済。

  test('顧客詳細画面 (light テーマ)', async () => {
    const page = sharedPage;
    await page.goto(`/customers/${customerId}`);
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot('customer-detail-light.png', {
      fullPage: true,
      // 見出し (顧客名に RUN_ID を含む) と紐付プロジェクト tbody を mask
      mask: [page.locator('h2').first(), page.locator('tbody')],
    });
  });
});
