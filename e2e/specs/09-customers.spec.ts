/**
 * E2E シナリオ: 顧客管理 (PR #111-2)
 *
 * カバー範囲:
 *   - /customers 一覧画面が admin のみアクセス可能 (admin で 200 / 非 admin で / リダイレクト)
 *   - 新規顧客をダイアログから登録 → 一覧に表示される
 *   - /customers/[id] 詳細画面で編集 → 変更が反映される
 *   - active Project 紐付きなし顧客の削除 (一覧の削除ボタン)
 *   - active Project 紐付きあり顧客のカスケード削除 (詳細画面)
 *   - プロジェクト作成フォームで Customer を select できる (PR #111-2 regression)
 *
 * 方針:
 *   Admin/general の 2 アカウントで挙動を分離検証。他 spec と同じく
 *   Step 単位で describe.configure({ mode: 'serial' }) で順序保証する。
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
import { createCustomerViaApi, createProjectViaApi } from '../fixtures/project';
import { snapshotStep } from '../fixtures/snapshot';

const ADMIN_EMAIL = `admin-pr111-customer-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

const GENERAL_EMAIL = `member-pr111-customer-${RUN_ID}@example.com`.toLowerCase();
const GENERAL_PW = 'E2eMember!Pw_2026';

const CUSTOMER_NAME = withRunId('PR111 顧客');
const CUSTOMER_NAME_EDITED = withRunId('PR111 顧客 (編集後)');
const CUSTOMER_FOR_CASCADE = withRunId('PR111 カスケード顧客');
const PROJECT_UNDER_CUSTOMER = withRunId('PR111 カスケード対象PJ');

let adminContext: BrowserContext;
let adminPage: Page;
let generalContext: BrowserContext;
let generalPage: Page;

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:customers 顧客管理 (PR #111-2)', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });
    await ensureGeneralUser(GENERAL_EMAIL, `一般 ${RUN_ID}`, GENERAL_PW);

    adminContext = await browser.newContext();
    adminPage = await adminContext.newPage();
    await adminPage.goto('/login');
    await adminPage.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await adminPage.getByLabel('パスワード').fill(ADMIN_PW);
    await adminPage.getByRole('button', { name: 'ログイン' }).click();
    await waitForProjectsReady(adminPage);

    generalContext = await browser.newContext();
    generalPage = await generalContext.newPage();
    await generalPage.goto('/login');
    await generalPage.getByLabel('メールアドレス').fill(GENERAL_EMAIL);
    await generalPage.getByLabel('パスワード').fill(GENERAL_PW);
    await generalPage.getByRole('button', { name: 'ログイン' }).click();
    await waitForProjectsReady(generalPage);
  });

  test.afterAll(async () => {
    await adminPage.close();
    await adminContext.close();
    await generalPage.close();
    await generalContext.close();
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('Step 1: 一般ユーザは /customers にアクセスすると / にリダイレクトされる', async () => {
    await generalPage.goto('/customers');
    await generalPage.waitForLoadState('networkidle');
    // admin 専用画面なので / (projects に相当) にリダイレクトされる
    expect(generalPage.url()).not.toContain('/customers');
  });

  test('Step 2: admin は /customers 画面を表示できる', async () => {
    const page = adminPage;
    await page.goto('/customers');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: '顧客管理' })).toBeVisible({
      timeout: 10_000,
    });
    await snapshotStep(page, 'customers-list-initial');
  });

  test('Step 3: 新規顧客をダイアログから登録 → 一覧に表示される', async () => {
    const page = adminPage;
    await page.goto('/customers');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: '新規顧客登録' }).click();
    // LESSONS §4.29: 「担当者」ラベルは「担当者メール」にも部分一致するので
    // exact:true で厳密一致させる。「顧客名 *」「部門」は念のため exact 化。
    await page.getByLabel('顧客名 *', { exact: true }).fill(CUSTOMER_NAME);
    await page.getByLabel('部門', { exact: true }).fill('情報システム部');
    await page.getByLabel('担当者', { exact: true }).fill('山田 太郎');

    // POST /api/customers レスポンス確定を待つ
    const postResponse = page.waitForResponse(
      (r) => r.url().endsWith('/api/customers') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '登録' }).click();
    const res = await postResponse;
    expect(res.ok(), `POST /api/customers failed: ${res.status()}`).toBeTruthy();

    await page.waitForLoadState('networkidle');
    await expect(
      page.locator('tbody tr').filter({ hasText: CUSTOMER_NAME }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('Step 4: 顧客名リンクから詳細画面に遷移 → 編集で反映される', async () => {
    const page = adminPage;
    await page.goto('/customers');
    await page.waitForLoadState('networkidle');

    await page.getByRole('link', { name: CUSTOMER_NAME }).first().click();
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: CUSTOMER_NAME })).toBeVisible({
      timeout: 10_000,
    });

    // 編集ダイアログを開く
    await page.getByRole('button', { name: '編集' }).click();
    // LESSONS §4.29: exact:true で「顧客名 *」が「担当者メール」等に部分一致しないよう防御
    const nameField = page.getByLabel('顧客名 *', { exact: true });
    await nameField.fill(CUSTOMER_NAME_EDITED);

    const patchResponse = page.waitForResponse(
      (r) =>
        r.url().includes('/api/customers/') && r.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: '更新' }).click();
    const res = await patchResponse;
    expect(res.ok(), `PATCH /api/customers failed: ${res.status()}`).toBeTruthy();

    // router.refresh() 後の描画 race を避けるため reload (LESSONS §4.20)
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: CUSTOMER_NAME_EDITED })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('Step 5: active Project なしの顧客は一覧から単純削除できる', async () => {
    const page = adminPage;
    // Step 3 で作成 → Step 4 で改名した顧客を一覧から削除する
    await page.goto('/customers');
    await page.waitForLoadState('networkidle');

    // window.confirm を許可
    page.once('dialog', (d) => d.accept());

    const row = page.locator('tbody tr').filter({ hasText: CUSTOMER_NAME_EDITED }).first();
    await row.getByRole('button', { name: '削除' }).click();

    await page.waitForLoadState('networkidle');
    await expect(
      page.locator('tbody tr').filter({ hasText: CUSTOMER_NAME_EDITED }),
    ).toHaveCount(0, { timeout: 10_000 });
  });

  test('Step 6: Project 作成フォームは顧客 select から選択する (customerName input 廃止)', async () => {
    const page = adminPage;

    // 先にカスケード用の顧客を API で作成しておく
    await createCustomerViaApi(page, { name: CUSTOMER_FOR_CASCADE });

    await page.goto('/projects');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: '新規プロジェクト' }).click();

    // 顧客フィールドが select になっていること (input[type=text] ではない)
    const customerSelect = page.locator('select').filter({
      has: page.locator(`option:has-text("${CUSTOMER_FOR_CASCADE}")`),
    }).first();
    await expect(customerSelect).toBeVisible({ timeout: 10_000 });

    // ダイアログを閉じる (作成は API で行うので UI からは送信しない)
    await page.keyboard.press('Escape');
  });

  test('Step 7: active Project 紐付きあり顧客は詳細画面のカスケード削除で消せる', async () => {
    const page = adminPage;

    // Step 6 で作成した顧客の ID を取得してプロジェクトを紐付け
    const listRes = await page.request.get('/api/customers');
    const listBody = await listRes.json();
    const cascadeCustomer = (
      listBody.data as Array<{ id: string; name: string }>
    ).find((c) => c.name === CUSTOMER_FOR_CASCADE);
    expect(cascadeCustomer, 'カスケード顧客が API 一覧から取得できること').toBeDefined();

    await createProjectViaApi(page, {
      name: PROJECT_UNDER_CUSTOMER,
      customerId: cascadeCustomer!.id,
    });

    // 顧客詳細画面で削除ボタン → カスケードダイアログ
    await page.goto(`/customers/${cascadeCustomer!.id}`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: CUSTOMER_FOR_CASCADE })).toBeVisible();

    // 紐付プロジェクト一覧に今作ったプロジェクトが出ている
    await expect(page.getByText(PROJECT_UNDER_CUSTOMER)).toBeVisible();

    await page.getByRole('button', { name: '削除' }).click();
    // カスケードダイアログが開いた (active project >0 の説明文を確認)
    await expect(
      page.getByText('active なプロジェクトが'),
    ).toBeVisible({ timeout: 5_000 });

    const deleteResponse = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/customers/${cascadeCustomer!.id}?`)
        && r.request().method() === 'DELETE',
    );
    await page.getByRole('button', { name: '削除する' }).click();
    const res = await deleteResponse;
    expect(res.ok(), `DELETE /api/customers cascade failed: ${res.status()}`).toBeTruthy();

    // 顧客一覧に戻り、削除されていることを確認
    await page.waitForURL('**/customers');
    await page.waitForLoadState('networkidle');
    await expect(
      page.locator('tbody tr').filter({ hasText: CUSTOMER_FOR_CASCADE }),
    ).toHaveCount(0, { timeout: 10_000 });
  });
});
