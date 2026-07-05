/**
 * E2E: クローズ済みプロジェクト (status='closed' = 完全な読み取り専用) のガード検証
 * (feat/closed-project-readonly v1.2.0 / 2026-06-12)。
 *
 * カバー範囲:
 *   - プロジェクト詳細に「読み取り専用」バナーが表示される (UI)
 *   - クローズ済みPJの資産編集 (ナレッジ PATCH) が 403 で拒否される (サーバ側ガード)
 *   - クローズ済みPJの資産へのコメント投稿が 403 PROJECT_CLOSED で拒否される
 *     (isCommentTargetFullyClosed: 紐付く全PJが closed のとき投稿不可)
 *   - プロジェクトクローズ時に active な投票/ホワイトボードセッション・open な Q&A スレッドが
 *     一括クローズされる (v1.5.0 cascade close)
 *
 * 設計: 稼働中のうちにナレッジを 1 件作成 → プロジェクトをクローズ → 各 write が弾かれることを確認。
 *   ロール判定 (作成者/admin) は維持したままクローズのみを弾く要件のため、admin でも 403 になる。
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import { ensureInitialAdmin, cleanupByRunId, disconnectDb } from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';
import { createProjectViaApi, addProjectMemberViaApi } from '../fixtures/project';

const ADMIN_EMAIL = `admin-closed-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';
const PROJECT_NAME = withRunId('クローズ読取専用PJ');

let ctx: BrowserContext;
let page: Page;
let projectId = '';
let knowledgeId = '';
// v1.5.0: cascade close 検証用
let votingSessionId = '';
let whiteboardSessionId = '';
let qaThreadId = '';

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:project:closed-readonly クローズ済みプロジェクトの読み取り専用ガード', () => {
  test.beforeAll(async ({ browser }) => {
    const adminUserId = await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });

    ctx = await browser.newContext();
    page = await ctx.newPage();

    // admin UI ログイン (MFA 無し、default テナント)
    await page.goto('/login');
    await page.getByLabel('組織 ID').fill('default');
    await page.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await page.getByLabel('パスワード').fill(ADMIN_PW);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await waitForProjectsReady(page);

    // 稼働中のプロジェクトを作成し、admin をメンバーとして追加してからナレッジを登録する
    const { id } = await createProjectViaApi(page, { name: PROJECT_NAME });
    projectId = id;

    // requireActualProjectMember が ProjectMember 行の存在を要求するため、admin を明示的に追加する
    await addProjectMemberViaApi(page, { projectId, userId: adminUserId, projectRole: 'pm_tl' });

    const kRes = await page.request.post(`/api/projects/${projectId}/knowledge`, {
      data: {
        title: withRunId('クローズ前ナレッジ'),
        knowledgeType: 'lesson',
        // v1.3.0 軽量入力 (2026-06-19): public は背景/内容/結果が必須
        background: 'E2E 背景',
        content: 'E2E 用ナレッジ',
        result: 'E2E 結果',
        visibility: 'public',
      },
    });
    expect(kRes.ok(), `knowledge create failed: ${kRes.status()} ${await kRes.text()}`).toBeTruthy();
    knowledgeId = (await kRes.json()).data.id;

    // v1.5.0 cascade close 検証: planning 状態のうちにアイデアツールのデータを作成しておく。
    // プロジェクトクローズ後にこれらが自動クローズされることを確認する。
    const futureEndsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1時間後

    const vsRes = await page.request.post(`/api/projects/${projectId}/idea/voting`, {
      data: {
        kind: 'pre',
        voteType: 'binary',
        title: withRunId('カスケードクローズ検証用投票'),
        endsAt: futureEndsAt,
        options: [
          { label: '選択肢A', displayOrder: 1 },
          { label: '選択肢B', displayOrder: 2 },
        ],
      },
    });
    expect(vsRes.ok(), `voting session create failed: ${vsRes.status()} ${await vsRes.text()}`).toBeTruthy();
    votingSessionId = (await vsRes.json()).data.id;

    const wbRes = await page.request.post(`/api/projects/${projectId}/idea/whiteboard`, {
      data: {
        title: withRunId('カスケードクローズ検証用ホワイトボード'),
        endsAt: futureEndsAt,
      },
    });
    expect(wbRes.ok(), `whiteboard session create failed: ${wbRes.status()} ${await wbRes.text()}`).toBeTruthy();
    whiteboardSessionId = (await wbRes.json()).data.id;

    const qaRes = await page.request.post(`/api/projects/${projectId}/idea/qa`, {
      data: { question: withRunId('カスケードクローズ検証用Q&A') },
    });
    expect(qaRes.ok(), `qa thread create failed: ${qaRes.status()} ${await qaRes.text()}`).toBeTruthy();
    qaThreadId = (await qaRes.json()).data.id;

    // planning → estimating → scheduling → executing の順に遷移 (飛び越し禁止)
    for (const nextStatus of ['estimating', 'scheduling', 'executing']) {
      const r = await page.request.patch(`/api/projects/${projectId}/status`, {
        data: { status: nextStatus },
      });
      expect(r.ok(), `→${nextStatus}: ${r.status()} ${await r.text()}`).toBeTruthy();
    }
    // v1.5.0 cascade close: 実際の UI 経路 (PATCH /api/projects/[id]) で closed に遷移。
    // 旧 /status route (changeProjectStatus・dormant) ではなく updateProject() を経由することで、
    // UI から操作した場合にもカスケードクローズが実行されることを検証する。
    const closeRes = await page.request.patch(`/api/projects/${projectId}`, {
      data: { status: 'closed' },
    });
    expect(closeRes.ok(), `→closed (PATCH /api/projects): ${closeRes.status()} ${await closeRes.text()}`).toBeTruthy();
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

  test('プロジェクトクローズ時: active な投票/ホワイトボード/Q&A セッションが一括クローズされる (v1.5.0 cascade close)', async () => {
    // 投票セッションが closed になっていることを確認
    const vsRes = await page.request.get(
      `/api/projects/${projectId}/idea/voting/${votingSessionId}`,
    );
    expect(vsRes.ok(), `voting GET failed: ${vsRes.status()}`).toBeTruthy();
    const vsBody = await vsRes.json();
    expect(vsBody.data.status, '投票セッションが cascade close により closed になること').toBe('closed');

    // ホワイトボードセッションが closed になっていることを確認
    const wbRes = await page.request.get(
      `/api/projects/${projectId}/idea/whiteboard/${whiteboardSessionId}`,
    );
    expect(wbRes.ok(), `whiteboard GET failed: ${wbRes.status()}`).toBeTruthy();
    const wbBody = await wbRes.json();
    expect(wbBody.data.status, 'ホワイトボードセッションが cascade close により closed になること').toBe('closed');

    // Q&A スレッドが closed になっていることを確認
    const qaRes = await page.request.get(
      `/api/projects/${projectId}/idea/qa/${qaThreadId}`,
    );
    expect(qaRes.ok(), `qa GET failed: ${qaRes.status()}`).toBeTruthy();
    const qaBody = await qaRes.json();
    expect(qaBody.data.status, 'Q&A スレッドが cascade close により closed になること').toBe('closed');
  });

  test('クローズ済みPJへの投票作成は 403 で拒否される (API レベルの書き込みガード)', async () => {
    const res = await page.request.post(`/api/projects/${projectId}/idea/voting`, {
      data: {
        kind: 'pre',
        voteType: 'binary',
        title: 'クローズ後の投票作成は不可',
        endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        options: [
          { label: 'A', displayOrder: 1 },
          { label: 'B', displayOrder: 2 },
        ],
      },
    });
    expect(res.status()).toBe(403);
  });
});
