/**
 * E2E: ADR-0030 Embedding 月次予算上限 + Beginner 100 件試用上限 + 請求タブ「今月請求金額」セクション
 *
 * カバー範囲:
 *   1. 使用量タブ UI 構造 (= 2 大セクション「生成AI系利用量」「DB系利用量」)
 *   2. セクション名変更 (= 当月使用量 → 当月 LLM 実行回数 / Embedding 利用量 → Embedding 生成回数)
 *   3. LLM 月次予算上限フォーム (= 当月 LLM 実行回数 直下、Beginner では非表示)
 *   4. Embedding 月次予算上限フォーム (= Embedding 生成回数 直下、Beginner では非表示)
 *   5. 請求タブ「今月請求金額」セクション (= 4 内訳タイル + 合計)
 *
 * 方針:
 *   - 初期 admin (default テナント = 管理テナント、Beginner 相当扱い) で UI 表示の存在確認のみ。
 *     金額変更 → ブロック検証は metered.test.ts のユニットテストで担保 (= 高速 + state DB 不要)。
 *   - data-testid を主要セレクタとして使用 (= 文言変更耐性)。
 *
 * 関連:
 *   - ADR: docs/adr/0030-embedding-monthly-budget-cap.md
 *   - UI: src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx
 *   - Memory: feedback_e2e_coverage_gate (新規 page/route 追加時は pnpm e2e:coverage-check)
 *
 * カバレッジ記録: docs/test/E2E_COVERAGE.md に追記
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID } from '../fixtures/run-id';
import { ensureInitialAdmin, cleanupByRunId, disconnectDb } from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';

const ADMIN_EMAIL = `admin-pr-adr0030-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

let sharedContext: BrowserContext;
let sharedPage: Page;

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:billing ADR-0030 Embedding 月次予算上限 UI', () => {
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
  });

  test.afterAll(async () => {
    await sharedPage.close();
    await sharedContext.close();
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('使用量タブ: 2 大セクション (生成AI系利用量 / DB系利用量) が存在する', async () => {
    const page = sharedPage;
    await page.goto('/settings/tenant?tab=usage');
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('generative-ai-usage-group')).toBeVisible();
    await expect(page.getByTestId('db-usage-group')).toBeVisible();
    await expect(page.getByText('生成AI系利用量', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('DB系利用量', { exact: false }).first()).toBeVisible();
  });

  test('使用量タブ: 当月 LLM 実行回数セクションと Embedding 生成回数セクションが存在する', async () => {
    const page = sharedPage;
    await page.goto('/settings/tenant?tab=usage');
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('usage-llm-section')).toBeVisible();
    await expect(page.getByTestId('usage-embedding-section')).toBeVisible();
    // 旧文言 (= 当月使用量 / Embedding 利用量) が残留していないこと
    // ★ Playwright strict mode 違反回避 (KDD §5.X+202、2026-05-31):
    //   セクション見出しと内部タイルラベルが同一文字列を含むため getByText() は複数マッチで strict mode 違反になる。
    //   Embedding セクション: <h2>"Embedding 生成回数 (= ...)"</h2> と <p>"Embedding 生成回数"</p> が両方 substring match。
    //   getByRole('heading') で見出し要素のみに限定する。LLM 側も将来のリネームに備えて同 pattern に統一。
    const llmSection = page.getByTestId('usage-llm-section');
    await expect(llmSection.getByRole('heading', { name: /当月 LLM 実行回数/ })).toBeVisible();
    const embeddingSection = page.getByTestId('usage-embedding-section');
    await expect(embeddingSection.getByRole('heading', { name: /Embedding 生成回数/ })).toBeVisible();
  });

  test('使用量タブ Beginner: 月次予算上限フォームは非表示 (= 月 50 / 100 件固定上限のため)', async () => {
    const page = sharedPage;
    await page.goto('/settings/tenant?tab=usage');
    await page.waitForLoadState('networkidle');
    // default tenant は Beginner 相当扱いのため BudgetCapForm は表示されないはず
    // (= 仕様: Beginner 非表示 / Expert・Pro のみ表示)
    await expect(page.getByTestId('budget-cap-form-llm')).toHaveCount(0);
    await expect(page.getByTestId('budget-cap-form-embedding')).toHaveCount(0);
  });

  test('請求タブ: 今月請求金額セクションが先頭に表示される (4 内訳 + 合計)', async () => {
    const page = sharedPage;
    await page.goto('/settings/tenant?tab=billing');
    await page.waitForLoadState('networkidle');

    const billingTotal = page.getByTestId('monthly-billing-total-section');
    await expect(billingTotal).toBeVisible();
    await expect(billingTotal.getByText('今月請求金額')).toBeVisible();
    await expect(billingTotal.getByText('LLM 費用')).toBeVisible();
    await expect(billingTotal.getByText('Embedding 費用')).toBeVisible();
    await expect(billingTotal.getByText('DB 容量超過 (想定)')).toBeVisible();
    await expect(billingTotal.getByText('Storage 超過 (想定)')).toBeVisible();
    // 合計タイル
    await expect(page.getByTestId('monthly-billing-total')).toBeVisible();
  });
});
