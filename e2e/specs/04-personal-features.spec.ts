/**
 * E2E シナリオ Step 8 (PR #94 / 段階導入 D)。
 *
 * カバー範囲: 個人機能 4 画面の基本フロー
 *   1. /my-tasks           — マイタスク画面が開ける (assignee 無しでも空表示で描画)
 *   2. /memos              — 個人メモ作成 (API) + 一覧表示 + UI 削除
 *   3. /all-memos          — 公開メモが全メモ画面に現れる
 *   4. /settings           — テーマ変更 UI で選択状態が切替わる
 *
 * 方針:
 *   - 前 PR で確立した sharedContext パターンを踏襲
 *   - memo 作成は API (createMemoViaApi) で軽量化、UI は一覧/削除/閲覧を検証
 *   - テーマ変更は UI の radio ボタンクリック、保存後に aria-checked で確認
 *
 * カバレッジ記録: docs/E2E_COVERAGE.md に [x] でマッピング
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import { ensureInitialAdmin, cleanupByRunId, disconnectDb } from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';
import { snapshotStep } from '../fixtures/snapshot';

const ADMIN_EMAIL = `admin-pr94-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

const PRIVATE_MEMO_TITLE = withRunId('個人メモ');
const PUBLIC_MEMO_TITLE = withRunId('公開メモ');

let sharedContext: BrowserContext;
let sharedPage: Page;

test.describe.configure({ mode: 'serial', retries: 0 });

async function createMemoViaApi(
  page: Page,
  params: { title: string; content: string; visibility: 'private' | 'public' },
): Promise<{ id: string }> {
  const res = await page.request.post('/api/memos', { data: params });
  if (!res.ok()) {
    throw new Error(`createMemoViaApi failed: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()).data;
}

test.describe('@feature:personal Step 8 個人機能', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });

    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();

    // admin UI ログイン (MFA 無し)
    await sharedPage.goto('/login');
    await sharedPage.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await sharedPage.getByLabel('パスワード').fill(ADMIN_PW);
    await sharedPage.getByRole('button', { name: 'ログイン' }).click();
    await waitForProjectsReady(sharedPage);
  });

  test.afterAll(async () => {
    await sharedPage.close();
    await sharedContext.close();
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('マイタスク画面 (/my-tasks) が表示される', async () => {
    const page = sharedPage;
    await page.goto('/my-tasks');
    await page.waitForLoadState('networkidle');
    // 実 <h2 className="text-xl font-semibold">マイタスク</h2>
    await expect(page.getByRole('heading', { name: 'マイタスク' })).toBeVisible({
      timeout: 10_000,
    });
    await snapshotStep(page, 'my-tasks-list');
  });

  test('メモ画面 (/memos) で作成済み個人メモが一覧に表示される', async () => {
    const page = sharedPage;
    // API でメモ作成 (UI フォーム依存を回避して軽量化)
    await createMemoViaApi(page, {
      title: PRIVATE_MEMO_TITLE,
      content: 'PR #94 E2E: 個人メモの一覧表示検証',
      visibility: 'private',
    });
    await page.goto('/memos');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'メモ', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(PRIVATE_MEMO_TITLE)).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'memos-list-with-private');
  });

  test('作成済みメモを UI から削除できる', async () => {
    const page = sharedPage;
    // 削除確認 dialog は window.confirm を使うので自動承諾する
    page.once('dialog', (dialog) => dialog.accept());

    // 対象行の「削除」ボタンをクリック (行内スコープで一意化)
    const row = page.locator('tr').filter({ hasText: PRIVATE_MEMO_TITLE });
    await row.getByRole('button', { name: '削除' }).click();

    await page.waitForLoadState('networkidle');
    await expect(page.getByText(PRIVATE_MEMO_TITLE)).toHaveCount(0, { timeout: 10_000 });
    await snapshotStep(page, 'memos-after-delete');
  });

  test('全メモ画面 (/all-memos) で公開メモが表示される', async () => {
    const page = sharedPage;
    await createMemoViaApi(page, {
      title: PUBLIC_MEMO_TITLE,
      content: 'PR #94 E2E: 全メモ一覧への露出検証',
      visibility: 'public',
    });
    await page.goto('/all-memos');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: '全メモ' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(PUBLIC_MEMO_TITLE)).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'all-memos-with-public');
  });

  test('設定画面 (/settings) でテーマを変更できる', async () => {
    const page = sharedPage;
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: '設定' })).toBeVisible({ timeout: 10_000 });

    // PATCH /api/settings/theme のレスポンスを明示的に待つ
    const themeRes = page.waitForResponse(
      (r) => r.url().includes('/api/settings/theme') && r.request().method() === 'PATCH',
    );
    // 別テーマ (ダーク) を選択。radiogroup 内の「ダークテーマ」ボタン
    await page.getByRole('radio', { name: 'ダークテーマ' }).click();
    const res = await themeRes;
    expect(res.ok()).toBeTruthy();

    // aria-checked で選択状態を検証 (a11y 標準)
    await expect(page.getByRole('radio', { name: 'ダークテーマ' })).toHaveAttribute(
      'aria-checked',
      'true',
      { timeout: 10_000 },
    );
    await snapshotStep(page, 'settings-theme-dark');

    // 元に戻す (他 test に影響しないよう)
    const revertRes = page.waitForResponse(
      (r) => r.url().includes('/api/settings/theme') && r.request().method() === 'PATCH',
    );
    await page.getByRole('radio', { name: 'ライトテーマ（デフォルト）' }).click();
    await revertRes;
  });
});
