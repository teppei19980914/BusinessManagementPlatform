/**
 * 認証ヘルパー (PR #93 / 段階導入 C)
 *
 * 役割:
 *   admin / general ユーザのログイン手順を spec から共通化する。
 *   PR #92 の hotfix で学んだ以下のパターンを 1 箇所に閉じ込める:
 *   - `**\/projects` glob 完全一致で待機 (waitForProjectsReady)
 *   - networkidle まで load state を保証
 *   - MFA 画面の `<Label htmlFor="code">認証コード</Label>` 経由 fill
 */

import type { BrowserContext, Page } from '@playwright/test';
import { generateTotpCode } from './totp';

/** 共通: ログイン後のリダイレクトチェーンが完全に落ち着くまで待機する。 */
export async function waitForProjectsReady(page: Page): Promise<void> {
  await page.waitForURL('**/projects', { timeout: 15_000 });
  await page.waitForLoadState('networkidle');
}

/**
 * admin ユーザで UI ログインし、MFA コードを入力して /projects に着地するまで。
 *
 * 前提:
 *   - sharedContext / sharedPage が `beforeAll` で作成済み
 *   - MFA シークレットは既に発行済 (呼び出し側が `mfaSecret` を保持)
 *   - 呼び出し前に `context.clearCookies()` で前セッションを破棄
 */
export async function loginAsAdminWithMfa(
  page: Page,
  context: BrowserContext,
  params: { email: string; password: string; mfaSecret: string },
): Promise<void> {
  await context.clearCookies();
  await page.goto('/login');
  await page.getByLabel('メールアドレス').fill(params.email);
  await page.getByLabel('パスワード').fill(params.password);
  await page.getByRole('button', { name: 'ログイン' }).click();

  await page.waitForURL(/\/login\/mfa/);
  await page.getByLabel('認証コード').fill(generateTotpCode(params.mfaSecret));
  await page.getByRole('button', { name: '検証' }).click();
  await waitForProjectsReady(page);
}

/**
 * general ユーザ (MFA 無し) の UI ログイン。
 */
export async function loginAsGeneral(
  page: Page,
  context: BrowserContext,
  params: { email: string; password: string },
): Promise<void> {
  await context.clearCookies();
  await page.goto('/login');
  await page.getByLabel('メールアドレス').fill(params.email);
  await page.getByLabel('パスワード').fill(params.password);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await waitForProjectsReady(page);
}
