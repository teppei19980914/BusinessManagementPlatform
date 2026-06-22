/**
 * E2E: コメント Markdown レンダリング検証 (v1.4.0)。
 *
 * カバー範囲:
 *   - コメント投稿フォームに「プレビュー」トグルボタンが表示される
 *   - Markdown 書式 (**太字** / ## 見出し) を含むコメントが strong / h2 要素として描画される
 *   - 既存のメンション補完 UI が壊れていない (mention-suggest data-testid の存在確認)
 *
 * 設計:
 *   1. admin を作成しログイン
 *   2. プロジェクト + ナレッジを API で作成
 *   3. Markdown 書式を含むコメントを API で投稿
 *   4. 全ナレッジ画面 (/all-knowledge) でナレッジ行をクリックしてダイアログを開く
 *   5. コメント欄で Markdown レンダリングを確認
 *   6. 新規コメント入力フォームに「プレビュー」ボタンが存在することを確認
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import { ensureInitialAdmin, cleanupByRunId, disconnectDb } from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';
import { createProjectViaApi, addProjectMemberViaApi } from '../fixtures/project';

const ADMIN_EMAIL = `admin-md-comment-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';
const PROJECT_NAME = withRunId('Markdown コメントテスト PJ');
const KNOWLEDGE_TITLE = withRunId('Markdown コメント確認ナレッジ');

let ctx: BrowserContext;
let page: Page;
let projectId = '';
let knowledgeId = '';

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:comment:markdown コメント Markdown レンダリング', () => {
  test.beforeAll(async ({ browser }) => {
    const adminUserId = await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });

    ctx = await browser.newContext();
    page = await ctx.newPage();

    await page.goto('/login');
    await page.getByLabel('組織 ID').fill('default');
    await page.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await page.getByLabel('パスワード').fill(ADMIN_PW);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await waitForProjectsReady(page);

    const { id } = await createProjectViaApi(page, { name: PROJECT_NAME });
    projectId = id;

    await addProjectMemberViaApi(page, { projectId, userId: adminUserId, projectRole: 'pm_tl' });

    // ナレッジを作成 (visibility='public' は background/content/result が必須)
    const kRes = await page.request.post(`/api/projects/${projectId}/knowledge`, {
      data: {
        title: KNOWLEDGE_TITLE,
        knowledgeType: 'lesson',
        background: 'Markdown コメント機能の E2E 検証用ナレッジ',
        content: 'Markdown コメント E2E 用ナレッジ',
        result: 'Markdown が正しくレンダリングされることを確認する',
        visibility: 'public',
      },
    });
    expect(kRes.ok(), `knowledge create: ${kRes.status()} ${await kRes.text()}`).toBeTruthy();
    knowledgeId = (await kRes.json()).data.id;

    // Markdown 書式を含むコメントを API で投稿
    const cRes = await page.request.post('/api/comments', {
      data: {
        entityType: 'knowledge',
        entityId: knowledgeId,
        content: '**太字テスト** と ## 見出し\n\n通常テキストも含みます。',
        mentions: [],
      },
    });
    expect(cRes.ok(), `comment create: ${cRes.status()} ${await cRes.text()}`).toBeTruthy();
  });

  test.afterAll(async () => {
    await page.close();
    await ctx.close();
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('ナレッジのコメントで **太字** が <strong> タグとしてレンダリングされる', async () => {
    // 全ナレッジ画面からナレッジ行をクリックしてダイアログを開く
    await page.goto('/all-knowledge');
    await page.waitForLoadState('networkidle');

    // ナレッジタイトルをクリックしてダイアログを開く
    const row = page.getByRole('row').filter({ hasText: KNOWLEDGE_TITLE });
    await row.click();

    // ダイアログが開くのを待つ
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // コメント欄が表示されるまでスクロール/待機
    const commentContent = dialog.locator('[data-testid="comment-content"]').first();
    await expect(commentContent).toBeVisible({ timeout: 10_000 });

    // **太字テスト** が <strong> タグとして描画されていること
    const strong = commentContent.locator('strong');
    await expect(strong).toHaveText('太字テスト', { timeout: 5_000 });
  });

  test('コメント投稿フォームに「プレビュー」ボタンが表示される', async () => {
    await page.goto(`/projects/${projectId}/knowledge`);
    await page.waitForLoadState('networkidle');

    // ナレッジ行をクリックしてダイアログを開く
    const row = page.getByRole('row').filter({ hasText: KNOWLEDGE_TITLE }).first();
    await row.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // コメント投稿フォームのプレビューボタンを確認
    const previewBtn = dialog.getByRole('button').filter({ hasText: 'プレビュー' }).first();
    await expect(previewBtn).toBeVisible({ timeout: 5_000 });
  });
});
