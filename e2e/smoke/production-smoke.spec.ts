/**
 * Post-Deploy Production Smoke Test
 * (e2e/smoke/ — playwright.config.smoke.ts 専用。通常 CI では実行されない)
 *
 * 目的:
 *   本番 or ステージング URL に対して「実インフラへの接続確認」を自動化し、
 *   毎リリースの人間スモーク (SMK-1〜7) のうち以下を代替する:
 *
 *   | SMK | 内容                                       | 本 spec での対応                    |
 *   |-----|--------------------------------------------|-------------------------------------|
 *   | SMK-1 | 実メール到達                             | CI E2E (spec 19) で staging 担保済み / 本番は Resend 設定不変のため割愛 |
 *   | SMK-2 | 本番 Cookie / セッション正常動作          | ログイン → /projects URL 到達で確認 |
 *   | SMK-3 | 資産を作成 → 一覧反映                    | URL リンク型添付作成 + 削除で代替   |
 *   | SMK-4 | ファイル添付往復 (実 Supabase Storage)   | 2フェーズアップロード → DL → 削除  |
 *   | SMK-5 | チャット / AI ヘルプの品質               | 既知 FAQ 質問 → 期待キーワード確認  |
 *   | SMK-7 | 主要画面の本番レンダリング               | /projects + /settings/tenant 確認   |
 *
 * 前提:
 *   - スモークテスト専用アカウントが SMOKE_TENANT_SLUG のテナントに存在すること
 *   - そのアカウントは MFA が無効であること (TOTP は動的コードのため自動化不可)
 *   - アカウントは admin 権限を持つこと (settings/tenant + attachment 操作に必要)
 *
 * 必須環境変数 (GitHub Secrets):
 *   SMOKE_TENANT_SLUG    : テナントの組織 ID (slug)
 *   SMOKE_ADMIN_EMAIL    : スモーク用アカウントのメールアドレス
 *   SMOKE_ADMIN_PASSWORD : スモーク用アカウントのパスワード
 *
 * 実行:
 *   pnpm playwright test --config=playwright.config.smoke.ts
 *   (通常 CI の playwright.config.ts / pnpm test:e2e では実行されない)
 */

import { test, expect, type Page } from '@playwright/test';

const TENANT_SLUG = process.env.SMOKE_TENANT_SLUG ?? '';
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD ?? '';

if (!TENANT_SLUG || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  throw new Error(
    'SMOKE_TENANT_SLUG / SMOKE_ADMIN_EMAIL / SMOKE_ADMIN_PASSWORD が未設定です。' +
      'GitHub Secrets または .env.smoke に設定してください。',
  );
}

/** 認証済 page.request で POST し、ok でなければ詳細付きで throw する。 */
async function apiPost(page: Page, url: string, data: Record<string, unknown>) {
  const res = await page.request.post(url, { data });
  if (!res.ok()) {
    throw new Error(`POST ${url} failed: ${res.status()} ${await res.text()}`);
  }
  return res;
}

test.describe.configure({ mode: 'serial', retries: 1 });

test.describe('post-deploy production smoke', () => {
  // 各テストで共有するクリーンアップリスト (失敗時も afterEach で削除)
  const cleanupItems: Array<{ type: 'attachment' | 'memo' | 'project'; id: string }> = [];

  test.afterEach(async ({ page }) => {
    // 逆順でクリーンアップ (attachment → memo → project)
    for (const item of [...cleanupItems].reverse()) {
      const url =
        item.type === 'attachment'
          ? `/api/attachments/${item.id}`
          : item.type === 'memo'
            ? `/api/memos/${item.id}`
            : `/api/projects/${item.id}`;
      await page.request.delete(url).catch(() => {});
    }
    cleanupItems.length = 0;
  });

  // ─────────────────────────────────────────────
  // SMK-2: ログイン / Cookie / セッション
  // ─────────────────────────────────────────────
  test('SMK-2: ログインが成功し /projects に到達できる (Cookie / セッション確認)', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByLabel('組織 ID').fill(TENANT_SLUG);
    await page.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForURL(/\/projects/, { timeout: 30_000 });
    await expect(page).toHaveURL(/\/projects/);
    // Cookie が正常にセットされ認証済みページが表示されている
    await expect(page.getByRole('main')).toBeVisible();
  });

  // ─────────────────────────────────────────────
  // SMK-7: 主要画面レンダリング
  // ─────────────────────────────────────────────
  test('SMK-7: /projects が 500 なくレンダリングされる', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('組織 ID').fill(TENANT_SLUG);
    await page.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForURL(/\/projects/, { timeout: 30_000 });

    await page.goto('/projects');
    await page.waitForLoadState('networkidle');
    // 500 エラーページでないこと
    await expect(page.getByText(/500|Internal Server Error/i)).not.toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
  });

  test('SMK-7: /settings/tenant が 500 なくレンダリングされる', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('組織 ID').fill(TENANT_SLUG);
    await page.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForURL(/\/projects/, { timeout: 30_000 });

    await page.goto('/settings/tenant');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/500|Internal Server Error/i)).not.toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
  });

  // ─────────────────────────────────────────────
  // SMK-3 + SMK-4: メモ作成 + 実 Supabase Storage ファイルアップロード往復
  // ─────────────────────────────────────────────
  test('SMK-4: 実 Supabase Storage — 2フェーズアップロード → ダウンロード確認 → 削除', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByLabel('組織 ID').fill(TENANT_SLUG);
    await page.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForURL(/\/projects/, { timeout: 30_000 });

    // メモを作成 (添付の親エンティティとして使用)
    const memoRes = await apiPost(page, '/api/memos', {
      title: '[SMOKE] Storage テスト用メモ',
      content: 'post-deploy smoke による実 Supabase Storage 検証用メモ',
      visibility: 'private',
    });
    const memoId: string = (await memoRes.json()).data.id;
    cleanupItems.push({ type: 'memo', id: memoId });

    // Phase 1: presigned URL を取得
    const uploadRes = await apiPost(page, '/api/attachments/upload', {
      entityType: 'memo',
      entityId: memoId,
      fileName: 'smoke-test.txt',
      sizeBytes: 13,
      mimeType: 'text/plain',
    });
    const { uploadUrl, token: _token, objectKey } = (await uploadRes.json()).data;
    expect(uploadUrl).toBeTruthy();
    expect(objectKey).toBeTruthy();

    // Phase 2a: Supabase Storage に直接 PUT (presigned URL へ)
    const putRes = await page.request.put(uploadUrl, {
      data: 'smoke test ok\n',
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(putRes.ok(), `Storage PUT failed: ${putRes.status()}`).toBeTruthy();

    // Phase 2b: finalize して添付レコードを作成
    const finalizeRes = await apiPost(page, '/api/attachments/finalize', {
      entityType: 'memo',
      entityId: memoId,
      objectKey,
      fileName: 'smoke-test.txt',
      displayName: '[SMOKE] smoke-test.txt',
      sizeBytes: 13,
      mimeType: 'text/plain',
    });
    const attachment = (await finalizeRes.json()).data;
    expect(attachment.id).toBeTruthy();
    expect(attachment.storageProvider).toBe('supabase');
    cleanupItems.push({ type: 'attachment', id: attachment.id });

    // ダウンロード: 302 リダイレクト先を確認 (実 signed URL が発行されること)
    const dlRes = await page.request.get(`/api/attachments/${attachment.id}/download`, {
      maxRedirects: 0,
    });
    // 302 redirect で signed URL に飛ぶ、または 200 直接返却
    expect([200, 302, 303].includes(dlRes.status()), `DL status: ${dlRes.status()}`).toBeTruthy();
    if (dlRes.status() !== 200) {
      const location = dlRes.headers()['location'];
      expect(location, 'signed URL が location ヘッダに含まれること').toBeTruthy();
    }

    // 削除 (cleanupItems の afterEach でも削除されるが、ここで明示的に検証)
    const delRes = await page.request.delete(`/api/attachments/${attachment.id}`);
    expect(delRes.ok()).toBeTruthy();
    cleanupItems.splice(cleanupItems.findIndex((c) => c.id === attachment.id), 1);
  });

  // ─────────────────────────────────────────────
  // SMK-5: AI ヘルプチャットの品質ゲート (実 Voyage + 実 Claude)
  // ─────────────────────────────────────────────
  test('SMK-5: AI ヘルプチャット — 既知 FAQ 質問に期待キーワードが含まれる', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByLabel('組織 ID').fill(TENANT_SLUG);
    await page.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await page.getByLabel('パスワード').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForURL(/\/projects/, { timeout: 30_000 });

    // FAB を開く
    await page.getByTestId('chat-fab').click();
    // ヘルプタブに切り替え
    await page.getByTestId('chat-panel-tab-help').click();
    // 既知 FAQ 質問を入力 (FAQ ID: password-strength-requirement)
    await page.getByTestId('help-chat-input-textarea').fill('パスワードの強度要件は?');
    await page.getByTestId('help-chat-submit').click();

    // 実 Claude の回答が返るまで待つ (最大 40 秒)
    const answer = page.getByTestId('help-chat-answer').first();
    await expect(answer).toBeVisible({ timeout: 40_000 });

    // 期待キーワード: FAQ には「10 文字以上」と明記されている
    await expect(answer).toContainText('10', { timeout: 40_000 });
  });
});
