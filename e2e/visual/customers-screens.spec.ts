/**
 * 視覚回帰テスト - 顧客管理画面 (PR #111-2)
 *
 * 対象:
 *   - /customers 一覧画面 (admin light テーマ)
 *   - /customers/[id] 詳細画面 (admin light テーマ)
 *
 * 設計判断:
 *   - RUN_ID 依存の顧客名は mask で除外して構造比較に絞る
 *   - 並列テスト環境で他 spec の顧客行が残存するのを避けるため、tbody 行は
 *     固定数 (自身が作成した 1 行) で baseline 生成が安定するよう、beforeAll
 *     で cleanup → 1 件作成する構成にしている。
 *   - ただし完全な決定化は困難 (他 spec が並列で作ると一覧に混ざる) なので、
 *     テーブル tbody 全体を mask し、ヘッダ + 空 state 枠のみを比較対象にする。
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

  test('顧客一覧画面 (light テーマ)', async () => {
    const page = sharedPage;
    await page.goto('/customers');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot('customers-list-light.png', {
      fullPage: true,
      // tbody 全体を mask (並列テストで行数が不定のため)
      mask: [page.locator('tbody')],
    });
  });

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
