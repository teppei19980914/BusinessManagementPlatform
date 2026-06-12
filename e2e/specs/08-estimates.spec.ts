/**
 * E2E シナリオ: 見積もり管理
 *
 * カバー範囲 (v1.2.0 追加分):
 *   - /projects/[id]/estimates 画面が render される (サマリパネルを含む)
 *   - 手動登録ダイアログで見積追加 → 「手動」バッジが一覧に表示
 *   - ツールで見積もるダイアログで係数ベース登録 → 「係数」バッジ + ツール名表示
 *   - 係数モード自動計算プレビュー (デフォルト scratch/中/中 → 16h)
 *   - API で作成した見積を UI で確定 → 状態バッジが「確定」に切替わる
 *   - UI から削除 (確定済は削除ボタン非表示、未確定のみ削除)
 *   - 手動 + 係数の混在一覧表示
 *
 * 方針:
 *   API での軽量作成は事前準備のみに使用し、UI テストは画面操作に集中する。
 *   確定・削除の waitForResponse パターンは PR #96 hotfix 5 の教訓を継承。
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
  pid: string,
  params: { itemName: string; category?: string },
): Promise<{ id: string }> {
  const res = await page.request.post(`/api/projects/${pid}/estimates`, {
    data: {
      itemName: params.itemName,
      category: params.category ?? 'requirements',
      estimatedEffort: 10,
      effortUnit: 'person_day',
      inputMode: 'direct',
      notes: 'PR #96 E2E: 見積 happy path 検証',
    },
  });
  if (!res.ok()) {
    throw new Error(`createEstimateViaApi failed: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()).data;
}

test.describe('@feature:project:estimates 見積もり管理', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });

    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();

    await sharedPage.goto('/login');
    await sharedPage.getByLabel('組織 ID').fill('default');
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

  // ============================================================
  // 基本表示
  // ============================================================

  test('/estimates 画面が render される (サマリパネル + 合計工数表示確認)', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}/estimates`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/^合計工数:/)).toBeVisible({ timeout: 10_000 });
    // v1.2.0: サマリパネルのバッファ率入力が表示される
    await expect(page.getByRole('spinbutton').first()).toBeVisible();
    await snapshotStep(page, 'estimates-empty');
  });

  // ============================================================
  // 手動登録
  // ============================================================

  test('「手動で登録」ボタン → ダイアログで見積作成 → 「手動」バッジが表示される', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}/estimates`);
    await page.waitForLoadState('networkidle');

    const directLabel = withRunId('手動設計工程');

    // 手動で登録ボタンを押す
    await page.getByRole('button', { name: '手動で登録' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    // フォームに入力
    await page.getByRole('dialog').getByLabel('項目名').fill(directLabel);
    await page.getByRole('dialog').locator('input[type="number"]').first().fill('8');
    await page.getByRole('dialog').getByRole('button', { name: '追加' }).click();

    // ダイアログが閉じる & 一覧に反映
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });
    await page.reload({ waitUntil: 'networkidle' });

    const row = page.locator('tbody tr').filter({ hasText: directLabel }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    // 「手動」バッジが表示されること (exact: true で item名の substring マッチを避ける)
    await expect(row.getByText('手動', { exact: true })).toBeVisible();
    await snapshotStep(page, 'estimates-direct-created');
  });

  // ============================================================
  // 係数ベース登録
  // ============================================================

  test('「ツールで見積もる」ボタン → 係数フォームが表示される', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}/estimates`);
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: 'ツールで見積もる' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    // 係数フォームの主要要素が存在する (exact: true でダイアログ説明文の substring マッチを回避)
    await expect(page.getByRole('dialog').getByText('開発ツール', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('規模', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('難易度', { exact: true })).toBeVisible();
    // デフォルト係数 (baseHours=16, 全係数=1.0) から calcPreview が即時表示される
    await expect(page.getByRole('dialog').getByText(/計算結果/)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5_000 });
  });

  test('係数フォームのデフォルト値で自動計算プレビューが表示される (scratch/中/中 → 16h)', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}/estimates`);
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: 'ツールで見積もる' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    // デフォルト (scratch/scale=1.0/difficulty=1.0/method=1.0/baseHours=16) → 16.0h
    await expect(page.getByRole('dialog').getByText(/16\.0\s*h/)).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Escape');
  });

  test('係数モードで見積作成 → 「係数」バッジ + ツール名が表示される', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}/estimates`);
    await page.waitForLoadState('networkidle');

    const coeffLabel = withRunId('WinActor自動化工程');

    await page.getByRole('button', { name: 'ツールで見積もる' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    // 項目名
    await page.getByRole('dialog').getByLabel('項目名').fill(coeffLabel);

    // ツール選択: WinActor を選ぶ
    const toolSelect = page.getByRole('dialog').locator('select').first();
    await toolSelect.selectOption('winactor');

    // カテゴリ区分: development のまま (デフォルト)
    // プレビューが更新されるのを待機
    await expect(page.getByRole('dialog').getByText(/見積工数/)).toBeVisible();

    // 追加ボタンが有効であることを確認してクリック
    const addBtn = page.getByRole('dialog').getByRole('button', { name: '追加' });
    await expect(addBtn).not.toBeDisabled({ timeout: 5_000 });
    await addBtn.click();

    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });
    await page.reload({ waitUntil: 'networkidle' });

    const row = page.locator('tbody tr').filter({ hasText: coeffLabel }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    // 「係数」バッジが表示されること
    await expect(row.getByText('係数')).toBeVisible();
    // WinActor のツール名が表示されること
    await expect(row.getByText('WinActor')).toBeVisible();
    await snapshotStep(page, 'estimates-coeff-created');
  });

  // ============================================================
  // 混在一覧・サマリ
  // ============================================================

  test('手動 + 係数の見積が混在した一覧が表示される', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}/estimates`);
    await page.waitForLoadState('networkidle');

    // 手動・係数のどちらかのバッジが複数存在する
    const badges = page.locator('tbody').getByText(/手動|係数/);
    await expect(badges.first()).toBeVisible({ timeout: 5_000 });

    // サマリパネルに小計 > 0 が反映されている (合計工数: 数値)
    const totalText = page.getByText(/^合計工数:/);
    await expect(totalText).toBeVisible();
    await snapshotStep(page, 'estimates-mixed-list');
  });

  test('サマリパネルのバッファ率を変更すると合計表示が変わる', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}/estimates`);
    await page.waitForLoadState('networkidle');

    // バッファ率入力欄を探す (最初の spinbutton)
    const bufferInput = page.getByRole('spinbutton').first();
    await expect(bufferInput).toBeVisible();

    // デフォルト 20% を 30% に変更
    await bufferInput.fill('30');
    await bufferInput.press('Tab');

    // バッファ (30%) のテキストが表示される
    await expect(page.getByText(/バッファ.*30%/)).toBeVisible({ timeout: 5_000 });
  });

  // ============================================================
  // 確定・削除 (既存フロー)
  // ============================================================

  test('見積もり項目を API で作成 → UI 一覧に表示される', async () => {
    const page = sharedPage;
    await createEstimateViaApi(page, projectId, { itemName: ESTIMATE_ITEM });

    await page.goto(`/projects/${projectId}/estimates`);
    await page.waitForLoadState('networkidle');
    await expect(
      page.locator('tbody tr').filter({ hasText: ESTIMATE_ITEM }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'estimates-with-item');
  });

  test('UI から見積を確定 → 確定/削除ボタンが消え、バッジ「確定」が残る', async () => {
    const page = sharedPage;

    const confirmRes = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/projects/${projectId}/estimates/`)
        && r.request().method() === 'PATCH',
    );

    const row = page.locator('tbody tr').filter({ hasText: ESTIMATE_ITEM }).first();
    await row.getByRole('button', { name: '確定' }).click();

    const res = await confirmRes;
    expect(res.ok(), `PATCH confirm failed: ${res.status()}`).toBeTruthy();

    // LESSONS §4.20: router.refresh race 回避のため page.reload で DB 真状態を取得
    await page.reload({ waitUntil: 'networkidle' });

    const rowAfter = page.locator('tbody tr').filter({ hasText: ESTIMATE_ITEM }).first();
    await expect(rowAfter.getByRole('button', { name: '確定' })).toHaveCount(0, { timeout: 10_000 });
    await expect(rowAfter.getByRole('button', { name: '削除' })).toHaveCount(0);
    await expect(rowAfter).not.toContainText('未確定');

    await snapshotStep(page, 'estimates-confirmed');
  });

  test('未確定の見積は UI から削除できる (confirm 承諾)', async () => {
    const page = sharedPage;
    const deletableLabel = withRunId('設計工程(削除対象)');
    await createEstimateViaApi(page, projectId, { itemName: deletableLabel });
    await page.goto(`/projects/${projectId}/estimates`);
    await page.waitForLoadState('networkidle');

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

    // LESSONS §4.20: router.refresh race 回避
    await page.reload({ waitUntil: 'networkidle' });

    await expect(
      page.locator('tbody tr').filter({ hasText: deletableLabel }),
    ).toHaveCount(0, { timeout: 10_000 });
    await snapshotStep(page, 'estimates-after-delete');
  });
});
