/**
 * E2E: /signup 心理的負荷低減 UX (feat/signup-friction-reduction / 2026-06-12)
 *
 * 検証観点 (テナント払い出し時の離脱防止施策):
 *   A1. 組織 ID (slug) はサーバが数字連番で自動採番 (入力欄なし)
 *       - サインアップ画面に組織 ID の入力欄が無い
 *       - 送信後の成功画面に、自動採番された数字の組織 ID が表示される
 *   B1. セクション順 = 組織情報 → 初期管理者 → プラン選択 → (Expert/Pro) 請求先
 *   A3. 送信後画面に「メール予告」(差出人・件名・到着目安) が表示される
 *
 * 設計:
 *   - セクション順・条件表示は DB 書き込みなしの純 UI 検証。
 *   - 組織 ID 自動採番の確認は実テナントを払い出すため、afterAll で cleanupTenantByRunId する。
 *
 * カバレッジ: docs/test/E2E_COVERAGE.md (/signup, /api/auth/signup)
 */

import { test, expect } from '@playwright/test';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import { cleanupTenantByRunId, disconnectDb } from '../fixtures/db';

test.describe('@feature:auth:signup 心理的負荷低減 UX', () => {
  test.describe('A1: 組織 ID はサーバ自動採番 (入力欄なし)', () => {
    test('サインアップ画面に組織 ID の入力欄が無い', async ({ page }) => {
      await page.goto('/signup');
      await page.waitForLoadState('networkidle');

      // 組織 ID 入力欄 (#slug) は存在しない
      await expect(page.locator('#slug')).toHaveCount(0);
      // 代わりに「自動で発行されます」の案内が表示される
      await expect(page.getByTestId('signup-org-id-auto-note')).toBeVisible();
    });
  });

  test.describe('B1: セクション順 + 条件表示', () => {
    test('legend の順序が 組織情報 → 初期管理者 → プラン選択 (Beginner)', async ({ page }) => {
      await page.goto('/signup');
      await page.waitForLoadState('networkidle');

      const legends = await page.locator('form fieldset > legend').allTextContents();
      const idxTenant = legends.findIndex((t) => t.includes('テナント (組織) 情報'));
      const idxAdmin = legends.findIndex((t) => t.includes('初期管理者'));
      const idxPlan = legends.findIndex((t) => t.includes('プラン選択'));

      expect(idxTenant).toBeGreaterThanOrEqual(0);
      expect(idxAdmin).toBeGreaterThan(idxTenant);
      expect(idxPlan).toBeGreaterThan(idxAdmin);

      // Beginner 既定では請求先情報は非表示
      expect(legends.some((t) => t.includes('請求先情報'))).toBe(false);
    });

    test('Expert を選ぶとプラン選択の後に請求先情報が出現する', async ({ page }) => {
      await page.goto('/signup');
      await page.waitForLoadState('networkidle');

      await page.getByRole('radio', { name: /Expert/ }).check();

      const legends = await page.locator('form fieldset > legend').allTextContents();
      const idxPlan = legends.findIndex((t) => t.includes('プラン選択'));
      const idxBilling = legends.findIndex((t) => t.includes('請求先情報'));

      expect(idxBilling).toBeGreaterThan(idxPlan);
    });
  });

  test.describe('A1/A3: 送信後の自動採番組織 ID + メール予告', () => {
    test.afterAll(async () => {
      await cleanupTenantByRunId(RUN_ID);
      await disconnectDb();
    });

    test('払い出し後の成功画面に自動採番された組織 ID とメール予告を表示する', async ({ page }) => {
      const email = `${withRunId('friction')}@example.com`.toLowerCase();

      await page.goto('/signup');
      await page.waitForLoadState('networkidle');

      // 組織名・お名前・メールのみ入力 (組織 ID は入力欄が無く、サーバが自動採番する)
      await page.locator('#name').fill(withRunId('friction-テナント'));
      await page.locator('#initialAdminName').fill(withRunId('friction-管理者'));
      await page.locator('#initialAdminEmail').fill(email);

      // 層3 (fresh email) 確定を待つ
      await expect(page.getByTestId('owned-tenant-warning')).toBeHidden();

      await page.getByTestId('signup-accept-terms').check();
      await page.getByTestId('signup-accept-privacy').check();

      const submit = page.getByTestId('signup-submit');
      await expect(submit).toBeEnabled();
      await submit.click();

      // 成功画面: 送信先メール
      await expect(page.getByTestId('signup-success-email')).toHaveText(email, { timeout: 15_000 });

      // A1: 自動採番された組織 ID (数字) が表示される
      const slugBlock = page.getByTestId('signup-success-slug');
      await expect(slugBlock).toBeVisible();
      await expect(slugBlock).toHaveText(/^\d{6,}$/);

      // A3: メール予告ブロック
      const expectation = page.getByTestId('signup-email-expectation');
      await expect(expectation).toBeVisible();
      await expect(expectation).toContainText('noreply@tasukiba.com');
      await expect(expectation).toContainText('たすきば - アカウントの設定');
      await expect(expectation).toContainText('1 分以内');
    });
  });
});
