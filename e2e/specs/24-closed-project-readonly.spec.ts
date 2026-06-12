/**
 * E2E: クローズ済みプロジェクト (status='closed' = 完全な読み取り専用) のガード検証
 * (feat/closed-project-readonly v1.2.0 / 2026-06-12)。
 *
 * カバー範囲:
 *   - プロジェクト詳細に「読み取り専用」バナーが表示される (UI)
 *   - クローズ済みPJの資産編集 (ナレッジ PATCH) が 403 で拒否される (サーバ側ガード)
 *   - クローズ済みPJの資産へのコメント投稿が 403 PROJECT_CLOSED で拒否される
 *     (isCommentTargetFullyClosed: 紐付く全PJが closed のとき投稿不可)
 *
 * 設計: 稼働中のうちにナレッジを 1 件作成 → プロジェクトをクローズ → 各 write が弾かれることを確認。
 *   ロール判定 (作成者/admin) は維持したままクローズのみを弾く要件のため、admin でも 403 になる。
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import { ensureInitialAdmin, cleanupByRunId, disconnectDb } from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';
import { createProjectViaApi } from '../fixtures/project';

const ADMIN_EMAIL = `admin-closed-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';
const PROJECT_NAME = withRunId('クローズ読取専用PJ');

let ctx: BrowserContext;
let page: Page;
let projectId = '';
let knowledgeId = '';

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:project:closed-readonly クローズ済みプロジェクトの読み取り専用ガード', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });

    ctx = await browser.newContext();
    page = await ctx.newPage();

    // admin UI ログイン (MFA 無し、default テナント)
    await page.goto('/login');
    await page.getByLabel('組織 ID').fill('default');
    await page.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await page.getByLabel('パスワード').fill(ADMIN_PW);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await waitForProjectsReady(page);

    // 稼働中のプロジェクトを作成し、クローズ前にナレッジを 1 件登録しておく
    const { id } = await createProjectViaApi(page, { name: PROJECT_NAME });
    projectId = id;

    const kRes = await page.request.post(`/api/projects/${projectId}/knowledge`, {
      data: {
        title: withRunId('クローズ前ナレッジ'),
        knowledgeType: 'lesson',
        content: 'E2E 用ナレッジ',
        visibility: 'public',
      },
    });
    expect(kRes.ok(), `knowledge create failed: ${kRes.status()} ${await kRes.text()}`).toBeTruthy();
    knowledgeId = (await kRes.json()).data.id;

    // プロジェクトをクローズ (= 読み取り専用へ遷移)
    const sRes = await page.request.patch(`/api/projects/${projectId}/status`, {
      data: { status: 'closed' },
    });
    expect(sRes.ok(), `status change failed: ${sRes.status()} ${await sRes.text()}`).toBeTruthy();
  });

  test.afterAll(async () => {
    await page.close();
    await ctx.close();
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('プロジェクト詳細に読み取り専用バナーが表示される', async () => {
    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByText('このプロジェクトはクローズ済み（読み取り専用）です'),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('クローズ済みPJのナレッジ編集 (PATCH) は 403 で拒否される', async () => {
    const res = await page.request.patch(
      `/api/projects/${projectId}/knowledge/${knowledgeId}`,
      { data: { content: 'クローズ後の編集は不可' } },
    );
    expect(res.status()).toBe(403);
  });

  test('クローズ済みPJの資産へのコメント投稿は 403 PROJECT_CLOSED で拒否される', async () => {
    const res = await page.request.post('/api/comments', {
      data: { entityType: 'knowledge', entityId: knowledgeId, content: 'クローズ後のコメントは不可' },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('PROJECT_CLOSED');
  });
});
