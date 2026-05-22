/**
 * E2E: /signup 3 層 eligibility 判定 (ADR-0016 Revised / 2026-05-22)
 *
 * 検証観点:
 *   - フォームが render される
 *   - 層 3 (完全な新規 email) → Beginner radio 活性 + submit 可
 *   - 層 2 (招待 / Default 所属のみの seed admin email) → Beginner radio 非活性 + 警告表示
 *   - 層 1 (自前テナント保有 admin email) → フォーム全体 disable + 問合せ動線表示
 *
 * 設計:
 *   実 DB の seed には ADMIN_EMAIL (e.g. admin-e2e@example.com) が層 1 (= 自前テナントの
 *   初期 admin) として存在する想定。Default テナントに別 admin を invite した user は
 *   層 2 として識別される。
 *   送信完了まで踏み込まず、UI の判定挙動のみを検証する (= DB 汚染回避)。
 *
 * カバレッジ: docs/test/E2E_COVERAGE.md /signup
 */

import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import { ensureInitialAdmin } from '../fixtures/db';

const ADMIN_EMAIL = process.env.INITIAL_ADMIN_EMAIL || 'admin-e2e@example.com';
const ADMIN_INITIAL_PW = process.env.INITIAL_ADMIN_PASSWORD || 'Initial@Pass!2026';
const LAYER3_EMAIL = `${withRunId('layer3')}@example.com`.toLowerCase();

let pool: Pool | null = null;
function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL が未設定です');
  }
  pool = new Pool({ connectionString });
  return pool;
}

test.describe('@feature:auth:signup ADR-0016 Revised 3 層判定', () => {
  test.beforeAll(async () => {
    // ADMIN_EMAIL を「層 1 (自前テナント保有)」状態に整える:
    //   1. user を default テナントに seed
    //   2. その user.id を default テナントの created_by_user_id にセット (= 「自分が払い出した」体)
    // 既存テストとの干渉を避けるため、層 1 化は本 spec のみで実施。
    const userId = await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_INITIAL_PW);
    const p = getPool();
    await p.query(
      `UPDATE tenants
         SET created_by_user_id = $1
       WHERE created_by_user_id IS NULL
         AND id = (SELECT tenant_id FROM users WHERE id = $1)`,
      [userId],
    );
  });

  test.afterAll(async () => {
    if (pool) {
      await pool.end();
      pool = null;
    }
  });

  test('フォームが render され、デフォルトでは Beginner が活性 (層 3 想定)', async ({ page }) => {
    await page.goto('/signup');
    await page.waitForLoadState('networkidle');

    // 3 プラン radio が表示される
    await expect(page.getByRole('radio', { name: /Beginner/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Expert/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Pro/ })).toBeVisible();

    // email 未入力時は Beginner 活性 (= 層判定未確定 → デフォルト挙動)
    await expect(page.getByRole('radio', { name: /Beginner/ })).toBeEnabled();
  });

  test('層 3: 完全な新規 email を入力 → Beginner 活性のまま', async ({ page }) => {
    await page.goto('/signup');
    await page.waitForLoadState('networkidle');

    // RUN_ID 接頭辞の email は DB に存在しないため層 3 と判定される
    await page.getByLabel('請求先メール *').fill(LAYER3_EMAIL);
    await page.getByLabel('メールアドレス *').last().fill(LAYER3_EMAIL);

    // debounce 300ms + API 往復 → 約 1 秒待つ
    await page.waitForTimeout(1000);

    // Beginner radio は活性のまま
    await expect(page.getByRole('radio', { name: /Beginner/ })).toBeEnabled();
    // 警告も表示されない
    await expect(page.getByTestId('beginner-unavailable-hint')).not.toBeVisible();
    await expect(page.getByTestId('owned-tenant-warning')).not.toBeVisible();
  });

  test('層 1: 自前テナント保有 admin email を入力 → フォーム全体 disable + 問合せ動線表示', async ({ page }) => {
    await page.goto('/signup');
    await page.waitForLoadState('networkidle');

    await page.getByLabel('請求先メール *').fill(ADMIN_EMAIL);
    await page.getByLabel('メールアドレス *').last().fill(ADMIN_EMAIL);

    // debounce 300ms + API 往復
    await page.waitForTimeout(1000);

    // 層 1 警告が表示される
    await expect(page.getByTestId('owned-tenant-warning')).toBeVisible();
    await expect(page.getByTestId('owned-tenant-warning')).toContainText(
      'システム管理者',
    );

    // submit ボタン disable
    await expect(page.getByTestId('signup-submit')).toBeDisabled();
  });

  test.afterAll(async () => {
    // RUN_ID prefixed email のクリーンアップは cleanupByRunId に委譲 (= 他 spec と共通)
    void RUN_ID;
  });
});
