/**
 * E2E: ADR-0034 外部データ API 連携インポート ウィザード（ベータ・② API 連携）
 *
 * カバー範囲（外部 HTTP は叩かない＝決定的）:
 *   1. admin で /settings/tenant/api-import が表示される
 *   2. サービス選択 → 接続情報フォーム（ベースURL・トークン）が出る
 *   3. トークン未入力では「接続」ボタンが無効（クライアント側バリデーション）
 *
 * 取得・マッピング・プレビュー・取込の本体は外部サービス依存のため E2E では叩かず、
 * connectors の *.test.ts（HTTP 境界モック）+ connect/discover・preview の route.test.ts + batch-preview/apply で担保。
 *
 * 関連: docs/adr/0034-external-tool-migration-import.md / docs/design/IMPORT_CONNECTORS.md
 * カバレッジ記録: docs/test/E2E_COVERAGE.md
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID } from '../fixtures/run-id';
import { ensureInitialAdmin, cleanupByRunId, disconnectDb } from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';

const ADMIN_EMAIL = `admin-api-import-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

let sharedContext: BrowserContext;
let sharedPage: Page;

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:import 外部データ API 連携インポート ウィザード', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });
    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();
    await sharedPage.goto('/login');
    await sharedPage.getByLabel('組織 ID').fill('default');
    await sharedPage.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await sharedPage.getByLabel('パスワード').fill(ADMIN_PW);
    await sharedPage.getByRole('button', { name: 'ログイン', exact: true }).click();
    await waitForProjectsReady(sharedPage);
  });

  test.afterAll(async () => {
    await sharedPage.close();
    await sharedContext.close();
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('ウィザードが表示され、サービス選択で接続フォームが出る', async () => {
    const page = sharedPage;
    await page.goto('/settings/tenant/api-import');
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: /外部データ API 連携インポート/ })).toBeVisible();

    // サービス選択 (Backlog) → 接続情報フォームが現れる
    await page.getByRole('button', { name: 'Backlog' }).click();
    await expect(page.getByText('ベースURL', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('API キー', { exact: false }).first()).toBeVisible();

    // トークン未入力では接続ボタンが無効
    await expect(page.getByRole('button', { name: '接続して取得元を読み込む' })).toBeDisabled();
  });
});
