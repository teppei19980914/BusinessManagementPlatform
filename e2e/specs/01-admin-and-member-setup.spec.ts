/**
 * E2E シナリオ Steps 1-6 (PR #92 / 段階導入 B)。
 *
 * カバー範囲:
 *   Step 1: 初期 admin でログイン + 強制パスワード変更 (forcePasswordChange=true)
 *   Step 2: admin が設定画面から MFA を有効化 (TOTP) + 再ログインで MFA 検証
 *   Step 3: admin が新規一般ユーザを招待 (/admin/users → POST /api/admin/users)
 *   Step 4: 招待メール (inbox 経由) から setup-password ページを開き、パスワード設定
 *   Step 5: admin API 経由でプロジェクト作成 (UI 詳細は PR #C で網羅)
 *   Step 6: admin API 経由でメンバー追加 → 一般ユーザ UI ログインで閲覧確認
 *
 * API 使用理由:
 *   プロジェクト作成フォームは 10 フィールド以上かつカスタム日付ピッカーを含み、UI 検証は
 *   PR #C (project feature 全網羅) のスコープ。PR #B は認証/招待フローの UI 品質を担保する。
 *   Playwright の page.request はブラウザと同じ Cookie を共有するため、認証済 API 呼び出しに適合する。
 *
 * 並列戦略: serial (前ステップの状態を共有)、本スイートは retries=0
 *
 * カバレッジ記録: docs/E2E_COVERAGE.md に [x] でマッピング
 */

import { test, expect } from '@playwright/test';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import { waitForMail, extractSetupPasswordUrl } from '../fixtures/inbox';
import { generateTotpCode } from '../fixtures/totp';
import { ensureInitialAdmin, cleanupByRunId, disconnectDb } from '../fixtures/db';

let startedAt: string;

const ADMIN_EMAIL = process.env.INITIAL_ADMIN_EMAIL || 'admin-e2e@example.com';
const ADMIN_INITIAL_PW = process.env.INITIAL_ADMIN_PASSWORD || 'E2eInitial!Pw_2026';
const ADMIN_NEW_PW = 'E2eNew!Pw_2026_Changed';

const MEMBER_EMAIL = `${withRunId('member')}@example.com`.toLowerCase();
const MEMBER_NAME = withRunId('メンバー');
const MEMBER_PW = 'E2eMember!Pw_2026';

const PROJECT_NAME = withRunId('E2Eプロジェクト');

// ステップ間で共有する状態
let mfaSecret = '';
let projectId = '';
let memberUserId = '';

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:auth:admin-flow Steps 1-6', () => {
  test.beforeAll(async () => {
    startedAt = new Date().toISOString();
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_INITIAL_PW);
  });

  test.afterAll(async () => {
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('Step 1: 初期 admin でログインしてパスワードを変更する', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await page.getByLabel('パスワード').fill(ADMIN_INITIAL_PW);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForURL(/\/projects|\/$/);

    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: '設定' })).toBeVisible();

    // Label 文言重複 (パスワード変更フォーム vs MFA) を避けるため、パスワード変更カード内で scope する
    const pwCard = page.locator('form').filter({ hasText: '現在のパスワード' });
    await pwCard.getByLabel('現在のパスワード').fill(ADMIN_INITIAL_PW);
    await pwCard.getByLabel('新しいパスワード', { exact: true }).fill(ADMIN_NEW_PW);
    await pwCard.getByLabel('新しいパスワード(確認)', { exact: false }).fill(ADMIN_NEW_PW);
    await pwCard.getByRole('button', { name: '変更' }).click();
    await expect(page.getByText('パスワードが変更されました')).toBeVisible({ timeout: 10_000 });
  });

  test('Step 2: admin が MFA を有効化する', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: 'MFA を有効化する' }).click();

    // 「手動入力用のシークレットキー」を開いて secret を取得
    await page.getByText('手動入力用のシークレットキー').click();
    // code 要素は複数あるので MFA カード内に絞る
    const mfaCard = page.locator('div').filter({ hasText: '多要素認証（MFA）' }).first();
    const secret = (await mfaCard.locator('code').first().innerText()).trim();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    mfaSecret = secret;

    await page.getByPlaceholder('6桁のコード').fill(generateTotpCode(mfaSecret));
    await page.getByRole('button', { name: '検証して有効化' }).click();
    // PR #91 で admin は常に強制有効化バッジ表示
    await expect(page.getByText('強制有効化 (解除不可)')).toBeVisible({ timeout: 10_000 });
  });

  test('Step 2b: MFA 有効化後の再ログインで /login/mfa 検証を通過する', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/login');
    await page.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await page.getByLabel('パスワード').fill(ADMIN_NEW_PW);
    await page.getByRole('button', { name: 'ログイン' }).click();

    await page.waitForURL(/\/login\/mfa/);
    await page.getByLabel('認証コード').fill(generateTotpCode(mfaSecret));
    await page.getByRole('button', { name: '検証' }).click();
    await page.waitForURL(/\/projects|\/$/, { timeout: 10_000 });
  });

  test('Step 3: admin が一般ユーザを招待する (招待メール送信)', async ({ page }) => {
    await page.goto('/admin/users');
    await page.getByRole('button', { name: '新規ユーザ登録' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('ユーザ名').fill(MEMBER_NAME);
    await dialog.getByLabel('メールアドレス').fill(MEMBER_EMAIL);
    // systemRole は default='general' のまま
    await dialog.getByRole('button', { name: '招待メールを送信' }).click();

    await expect(page.getByText('招待メールを送信しました')).toBeVisible({ timeout: 10_000 });

    const mail = await waitForMail(MEMBER_EMAIL, { after: startedAt });
    expect(mail.subject).toContain('アカウントの設定');
  });

  test('Step 4: 一般ユーザが招待メールからパスワードを設定する', async ({ page, context }) => {
    await context.clearCookies();
    const mail = await waitForMail(MEMBER_EMAIL, { after: startedAt });
    const setupUrl = extractSetupPasswordUrl(mail);

    await page.goto(setupUrl);
    await expect(page.getByRole('heading', { name: 'たすきば' })).toBeVisible({ timeout: 10_000 });
    await page.getByLabel('パスワード', { exact: true }).fill(MEMBER_PW);
    await page.getByLabel('パスワード（確認）').fill(MEMBER_PW);
    await page.getByRole('button', { name: 'パスワードを設定' }).click();

    // general は即 done (admin 強制 MFA は PR #91 で admin のみ対象)
    await expect(page.getByRole('heading', { name: 'セットアップ完了' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/リカバリーコード/)).toBeVisible();
  });

  test('Step 5: admin がプロジェクトを作成する (API 経由)', async ({ page, context }) => {
    // admin セッションを復元 (MFA 通過後)
    await context.clearCookies();
    await page.goto('/login');
    await page.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await page.getByLabel('パスワード').fill(ADMIN_NEW_PW);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForURL(/\/login\/mfa/);
    await page.getByLabel('認証コード').fill(generateTotpCode(mfaSecret));
    await page.getByRole('button', { name: '検証' }).click();
    await page.waitForURL(/\/projects|\/$/, { timeout: 10_000 });

    const today = new Date().toISOString().slice(0, 10);
    const in30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const res = await page.request.post('/api/projects', {
      data: {
        name: PROJECT_NAME,
        customerName: withRunId('顧客'),
        purpose: 'E2E テスト用プロジェクト',
        background: 'E2E テストでカバーする基本シナリオ',
        scope: 'Step 5 範囲のみ',
        devMethod: 'scratch',
        plannedStartDate: today,
        plannedEndDate: in30,
        businessDomainTags: [],
        techStackTags: [],
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    projectId = body.data.id;
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

    // 一覧画面で表示されることを確認
    await page.goto('/projects');
    await expect(page.getByText(PROJECT_NAME)).toBeVisible({ timeout: 10_000 });
  });

  test('Step 6a: admin がプロジェクトに一般ユーザを追加する (API 経由)', async ({ page }) => {
    // 対象ユーザ ID を特定 (画面経由より API で取得)
    const userListRes = await page.request.get('/api/admin/users');
    const users = (await userListRes.json()).data as Array<{ id: string; email: string }>;
    const invitee = users.find((u) => u.email === MEMBER_EMAIL);
    expect(invitee, 'invited member should exist').toBeTruthy();
    memberUserId = invitee!.id;

    const addRes = await page.request.post(`/api/projects/${projectId}/members`, {
      data: {
        userId: memberUserId,
        projectRole: 'member',
      },
    });
    expect(addRes.ok()).toBeTruthy();
  });

  test('Step 6b: 一般ユーザがログインしてプロジェクトを閲覧できる', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/login');
    await page.getByLabel('メールアドレス').fill(MEMBER_EMAIL);
    await page.getByLabel('パスワード').fill(MEMBER_PW);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForURL(/\/projects|\/$/, { timeout: 10_000 });

    await page.goto('/projects');
    await expect(page.getByText(PROJECT_NAME)).toBeVisible({ timeout: 10_000 });
  });
});
