/**
 * E2E: /signup 3 層 eligibility の **完全送信** 検証
 * (test/release-acceptance-e2e / 2026-06 / RELEASE_ACCEPTANCE_TEST.md 付録A)
 *
 * 既存 14-signup-3tier-eligibility は「送信前の UI 判定」のみ (DB 汚染回避)。本 spec は
 * 単一 email を状態遷移させて層2 → 層1 を **送信完了まで** 含めて検証する:
 *   1. 層2 (seedLayer2MemberEmail で Default テナントに member-not-owner として seed)
 *      → /signup で Beginner radio 無効 + beginner-unavailable-hint 表示
 *      → Expert で完全送信すると成功し、当該 email が expert テナントを保有 (= 以後 層1)
 *   2. 層1 (上記で自前テナント保有になった email)
 *      → /signup で owned-tenant-warning 表示 + submit 無効
 *
 * 後始末: cleanupTenantByRunId (expert テナント物理 purge) + cleanupByRunId (Default の層2 user 削除)。
 *
 * カバレッジ: docs/test/E2E_COVERAGE.md (/api/auth/signup BEGINNER_REQUIRES_UPGRADE / OWNED_TENANT_EXISTS)
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import { signupTenantViaUi } from '../fixtures/signup';
import { seedLayer2MemberEmail, cleanupByRunId, cleanupTenantByRunId, disconnectDb } from '../fixtures/db';

let context: BrowserContext;
let page: Page;

const LAYER2_EMAIL = `${withRunId('elig')}@example.com`.toLowerCase();
const LAYER2_PW = 'E2eLayer2!Pw_2026';

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:auth:signup 3層 eligibility 完全送信 (層2→層1)', () => {
  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    // 層2 状態を作る: email を Default テナントの general user として seed (= users に存在するが
    //   created_by_user_id ではない)。
    await seedLayer2MemberEmail(LAYER2_EMAIL, withRunId('層2ユーザ'), LAYER2_PW);
  });

  test.afterAll(async () => {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    // expert テナント (RUN_ID 名) を物理 purge → Default の層2 user を email LIKE で削除
    await cleanupTenantByRunId(RUN_ID);
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('層2: 既登録 email → Beginner radio 無効 + beginner-unavailable-hint 表示', async () => {
    await page.goto('/signup');
    await page.waitForLoadState('networkidle');
    await page.locator('#initialAdminEmail').fill(LAYER2_EMAIL);

    // debounce 300ms + eligibility 往復後、層2 ヒントが出るまで auto-retry 待機
    await expect(page.getByTestId('beginner-unavailable-hint')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('radio', { name: /Beginner/ })).toBeDisabled();
    // 層2 は signupAllowed=true なので層1 警告は出ない
    await expect(page.getByTestId('owned-tenant-warning')).toBeHidden();
  });

  test('層2: Expert で完全送信すると成功する (BEGINNER_REQUIRES_UPGRADE を回避)', async () => {
    // signupTenantViaUi は emailOverride + plan=expert で層2 email の完全送信を行う。
    //   完了後この email は expert テナントの createdByUserId = 以後 層1。
    const result = await signupTenantViaUi(page, {
      label: 'elig',
      plan: 'expert',
      emailOverride: LAYER2_EMAIL,
    });
    expect(result.plan).toBe('expert');
    // ログイン成功 = /projects 着地済
    await expect(page).toHaveURL(/\/projects/);
  });

  test('層1: 自前テナント保有 email → owned-tenant-warning 表示 + submit 無効', async () => {
    // 公開フォームは未認証前提。前テストでログイン済のため cookie をクリアしてから /signup へ。
    await context.clearCookies();
    await page.goto('/signup');
    await page.waitForLoadState('networkidle');
    await page.locator('#initialAdminEmail').fill(LAYER2_EMAIL);

    await expect(page.getByTestId('owned-tenant-warning')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('owned-tenant-warning')).toContainText('システム管理者');
    await expect(page.getByTestId('signup-submit')).toBeDisabled();
  });
});
