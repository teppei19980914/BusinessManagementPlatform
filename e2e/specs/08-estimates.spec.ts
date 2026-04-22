/**
 * E2E シナリオ: 見積もり管理 (PR #96)
 *
 * カバー範囲:
 *   - /projects/[id]/estimates 画面が render される
 *   - 見積もり項目を API で作成 → UI 一覧に表示される
 *   - UI から確定 → 状態バッジが「確定」に切替わる
 *   - UI から削除 (確定済は削除ボタン非表示、未確定のみ削除)
 *
 * 方針:
 *   見積フォームは 7 フィールド + NumberInput + Select の組み合わせ。
 *   作成は API で軽量化、UI は表示/確定/削除の state 遷移に集中。
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import { ensureInitialAdmin, cleanupByRunId, disconnectDb } from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';
import { createProjectViaApi } from '../fixtures/project';
import { snapshotStep } from '../fixtures/snapshot';

const ADMIN_EMAIL = `admin-pr96-estimate-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

const PROJECT_NAME = withRunId('PR96見積プロジェクト');
const ESTIMATE_ITEM = withRunId('要件定義工程');

let sharedContext: BrowserContext;
let sharedPage: Page;
let projectId = '';

test.describe.configure({ mode: 'serial', retries: 0 });

async function createEstimateViaApi(
  page: Page,
  projectId: string,
  params: { itemName: string },
): Promise<{ id: string }> {
  const res = await page.request.post(`/api/projects/${projectId}/estimates`, {
    data: {
      itemName: params.itemName,
      category: 'requirements',
      devMethod: 'scratch',
      estimatedEffort: 10,
      effortUnit: 'person_day',
      rationale: 'PR #96 E2E: 見積 happy path 検証',
    },
  });
  if (!res.ok()) {
    throw new Error(`createEstimateViaApi failed: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()).data;
}

test.describe('@feature:project:estimates 見積もり管理 (PR #96)', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });

    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();

    await sharedPage.goto('/login');
    await sharedPage.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await sharedPage.getByLabel('パスワード').fill(ADMIN_PW);
    await sharedPage.getByRole('button', { name: 'ログイン' }).click();
    await waitForProjectsReady(sharedPage);

    const { id } = await createProjectViaApi(sharedPage, { name: PROJECT_NAME });
    projectId = id;
  });

  test.afterAll(async () => {
    await sharedPage.close();
    await sharedContext.close();
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('/estimates 画面が render され、見積もり管理 見出しが表示される', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}/estimates`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: '見積もり管理' })).toBeVisible({
      timeout: 10_000,
    });
    await snapshotStep(page, 'estimates-empty');
  });

  test('見積もり項目を API で作成 → UI 一覧に表示される', async () => {
    const page = sharedPage;
    await createEstimateViaApi(page, projectId, { itemName: ESTIMATE_ITEM });

    await page.goto(`/projects/${projectId}/estimates`);
    await page.waitForLoadState('networkidle');
    // 一覧行は tbody tr + .first() (LESSONS_LEARNED §4.11)
    await expect(
      page.locator('tbody tr').filter({ hasText: ESTIMATE_ITEM }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'estimates-with-item');
  });

  test('UI から見積を確定 → 確定/削除ボタンが消え、バッジ「確定」が残る', async () => {
    const page = sharedPage;

    // PATCH 応答を click 前に予約 (waitForResponse は register が click より先に必要)。
    // router.refresh() は fire-and-forget で click の await を経由しないため、
    // `waitForLoadState('networkidle')` だけでは fetch flight を捕捉できず
    // 誤って 0ms で解決する (PR #96 hotfix 5 事例)。
    const confirmRes = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/projects/${projectId}/estimates/`)
        && r.request().method() === 'PATCH',
    );

    const row = page.locator('tbody tr').filter({ hasText: ESTIMATE_ITEM }).first();
    await row.getByRole('button', { name: '確定' }).click();

    const res = await confirmRes;
    expect(res.ok(), `PATCH confirm failed: ${res.status()}`).toBeTruthy();

    // LESSONS §4.20: router.refresh() は fire-and-forget + React 描画の非決定性で
    // waitForLoadState('networkidle') だけでは race が残る (PR #96 hotfix 5 / PR #97
    // CI で再発確認)。確定後の UI 検証は page.reload() で DB の真の状態を強制取得する
    // 方が信頼できる。デメリット: 「router.refresh による自動再描画」の検証は犠牲に
    // なるが、それは React/Next.js framework の責務であり spec 08 の対象外と割り切る。
    await page.reload({ waitUntil: 'networkidle' });

    // `toContainText('確定')` は行内の「確定」ボタン文字列にもマッチするため
    // 確定前/後を識別できない。確定後の UI 変化は以下の 2 つで判定する:
    //   1. 「確定」ボタンが消える (button 自体が DOM から外れる)
    //   2. 「削除」ボタンも消える (確定済は削除不可の仕様)
    // Badge は残るが、視覚的に「未確定」が「確定」に変わるのは snapshot で視認する。
    const rowAfter = page.locator('tbody tr').filter({ hasText: ESTIMATE_ITEM }).first();
    await expect(rowAfter.getByRole('button', { name: '確定' })).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(rowAfter.getByRole('button', { name: '削除' })).toHaveCount(0);
    // 「未確定」バッジが消えていること (以前の状態が完全にクリアされた確証)
    await expect(rowAfter).not.toContainText('未確定');

    await snapshotStep(page, 'estimates-confirmed');
  });

  test('未確定の見積は UI から削除できる (confirm 承諾)', async () => {
    const page = sharedPage;
    const deletableLabel = withRunId('設計工程(削除対象)');
    await createEstimateViaApi(page, projectId, { itemName: deletableLabel });
    await page.goto(`/projects/${projectId}/estimates`);
    await page.waitForLoadState('networkidle');

    // DELETE 完了を明示的に待機 (click 前に予約)
    const deleteRes = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/projects/${projectId}/estimates/`)
        && r.request().method() === 'DELETE',
    );
    page.once('dialog', (dialog) => dialog.accept());
    const row = page.locator('tbody tr').filter({ hasText: deletableLabel }).first();
    await row.getByRole('button', { name: '削除' }).click();
    const res = await deleteRes;
    expect(res.ok(), `DELETE failed: ${res.status()}`).toBeTruthy();

    // LESSONS §4.20: 確定テストと同じく router.refresh race 回避のため page.reload
    // で DB 真状態を強制取得 (waitForLoadState 単独では 1ms で即解決する race)。
    await page.reload({ waitUntil: 'networkidle' });

    await expect(
      page.locator('tbody tr').filter({ hasText: deletableLabel }),
    ).toHaveCount(0, { timeout: 10_000 });
    await snapshotStep(page, 'estimates-after-delete');
  });
});
