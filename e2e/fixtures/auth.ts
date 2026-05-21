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
 * ADR-0016 (2026-05-20): multi-tenant 対応で 組織 ID (tenantSlug) を共通入力ヘルパとして抽出。
 *   テスト fixture が tenantSlug を渡さない場合は default-tenant ('default') を使う。
 *   理由: ensureInitialAdmin が users.tenant_id の DB DEFAULT = DEFAULT_TENANT_ID
 *         (= '00000000-0000-0000-0000-000000000001') に admin を作成するため。
 */
const DEFAULT_E2E_TENANT_SLUG = process.env.E2E_TENANT_SLUG ?? 'default';

async function fillLoginForm(
  page: Page,
  params: { email: string; password: string; tenantSlug?: string },
): Promise<void> {
  // ADR-0016: 組織 ID 欄を最初に入力 (URL クエリ `?tenant=...` でも自動入力されるが
  //   テストでは明示的に入力する方が読みやすい)。
  await page.getByLabel('組織 ID').fill(params.tenantSlug ?? DEFAULT_E2E_TENANT_SLUG);
  await page.getByLabel('メールアドレス').fill(params.email);
  await page.getByLabel('パスワード').fill(params.password);
}

/**
 * admin ユーザで UI ログインし、MFA コードを入力して /projects に着地するまで。
 *
 * 前提:
 *   - sharedContext / sharedPage が `beforeAll` で作成済み
 *   - MFA シークレットは既に発行済 (呼び出し側が `mfaSecret` を保持)
 *   - 呼び出し前に `context.clearCookies()` で前セッションを破棄
 *
 * ADR-0016 (2026-05-20): tenantSlug を任意パラメータとして追加 (デフォルトは MANAGEMENT_TENANT_SLUG)
 */
export async function loginAsAdminWithMfa(
  page: Page,
  context: BrowserContext,
  params: { email: string; password: string; mfaSecret: string; tenantSlug?: string },
): Promise<void> {
  await context.clearCookies();
  await page.goto('/login');
  await fillLoginForm(page, params);
  // PR #420: ログイン画面に「履歴をクリア」ボタン追加で substring match 衝突するため exact 化 (KDD §5.X+96)
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();

  await page.waitForURL(/\/login\/mfa/);
  await page.getByLabel('認証コード').fill(generateTotpCode(params.mfaSecret));

  // fix/jwt-resign-for-netlify (PR #396):
  //   旧仕様は MfaForm が `await update({ mfaVerified: true })` (= POST /api/auth/session) を
  //   呼んでから window.location.href で遷移していたが、Netlify で Set-Cookie が反映されない
  //   問題があったため、verify API 自体が JWT を直接再署名する形に変更済。
  //   `POST /api/auth/session` は呼ばれないので wait してはいけない (永久タイムアウト)。
  const verifyRes = page.waitForResponse(
    (r) => r.url().includes('/api/auth/mfa/verify') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '検証' }).click();
  const res = await verifyRes;
  if (!res.ok()) {
    throw new Error(`MFA verify failed: ${res.status()} ${await res.text()}`);
  }
  await waitForProjectsReady(page);
}

/**
 * general ユーザ (MFA 無し) の UI ログイン。
 *
 * ADR-0016 (2026-05-20): tenantSlug を任意パラメータとして追加。
 */
export async function loginAsGeneral(
  page: Page,
  context: BrowserContext,
  params: { email: string; password: string; tenantSlug?: string },
): Promise<void> {
  await context.clearCookies();
  await page.goto('/login');
  await fillLoginForm(page, params);
  // PR #420: ログイン画面に "履歴をクリア" ボタンを追加した際、
  //   { name: 'ログイン' } の substring match と衝突した。{ exact: true } で
  //   submit ボタンのみ厳密マッチさせる (= 将来「ログイン...」を含む新ボタンが追加されても破綻しない)。
  //   KDD §5.X+96 参照
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await waitForProjectsReady(page);
}
