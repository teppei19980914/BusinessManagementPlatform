/**
 * E2E: テナント セルフ解約 (test/release-acceptance-e2e / 2026-06 / RELEASE_ACCEPTANCE_TEST.md TC-RA-70〜75)
 *
 * 検証:
 *   1. 名称不一致 → 422 NAME_MISMATCH (誤操作防止)
 *   2. 名称一致 → 成功 + 「90 日経過後に物理削除」メッセージ
 *   3. 解約後は admin が isActive=false になりログイン不可
 *   4. 同 email で /signup を再試行すると層1 (OWNED_TENANT_EXISTS) でブロックされる
 *      (= セルフ解約は論理削除で created_by_user_id が残るため。abuse 防止設計の挙動)
 *
 * 後始末: cleanupTenantByRunId で論理削除済テナント + users を物理 purge (RUN_ID 痕跡の完全消去)。
 *
 * カバレッジ: docs/test/E2E_COVERAGE.md (/api/tenants/me/self-delete)
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID } from '../fixtures/run-id';
import { signupTenantViaUi, type SignupResult } from '../fixtures/signup';
import { cleanupTenantByRunId, disconnectDb } from '../fixtures/db';

let context: BrowserContext;
let page: Page;
let tenant: SignupResult;

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:tenant セルフ解約 + 解約後の挙動', () => {
  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    tenant = await signupTenantViaUi(page, { label: 'del', plan: 'beginner' });
  });

  test.afterAll(async () => {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await cleanupTenantByRunId(RUN_ID);
    await disconnectDb();
  });

  test('TC-RA-71: テナント名不一致の解約は 422 で拒否される', async () => {
    const res = await page.request.post('/api/tenants/me/self-delete', {
      data: { tenantName: `${tenant.tenantName}-WRONG` },
    });
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(body.error?.code).toBe('NAME_MISMATCH');
  });

  test('TC-RA-72: テナント名一致で解約成功 + 90 日メッセージ', async () => {
    const res = await page.request.post('/api/tenants/me/self-delete', {
      data: { tenantName: tenant.tenantName },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data?.ok).toBe(true);
    expect(body.data?.message ?? '').toContain('90 日');
  });

  test('TC-RA-73: 解約後は admin がログイン不可 (isActive=false)', async () => {
    await context.clearCookies();
    await page.goto('/login');
    await page.getByLabel('組織 ID').fill(tenant.slug);
    await page.getByLabel('メールアドレス').fill(tenant.email);
    await page.getByLabel('パスワード').fill(tenant.password);
    await page.getByRole('button', { name: 'ログイン', exact: true }).click();
    // 認証失敗 = /projects に到達しない。ログインフォームに留まる。
    await page.waitForTimeout(2_000);
    await expect(page).not.toHaveURL(/\/projects/);
    await expect(page.getByLabel('メールアドレス')).toBeVisible();
  });

  test('TC-RA-A5: 解約後も同 email の /signup は層1 (OWNED_TENANT_EXISTS) でブロック', async () => {
    // 論理削除でも created_by_user_id は残るため、abuse 防止設計により層1 のまま。
    await context.clearCookies();
    await page.goto('/signup');
    await page.waitForLoadState('networkidle');
    await page.locator('#initialAdminEmail').fill(tenant.email);

    await expect(page.getByTestId('owned-tenant-warning')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('signup-submit')).toBeDisabled();
  });
});
