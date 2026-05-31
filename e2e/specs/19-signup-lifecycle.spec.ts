/**
 * E2E: 公開 /signup テナント払い出し → 全資産 CRUD ライフサイクル
 * (test/release-acceptance-e2e / 2026-06 / docs/test/RELEASE_ACCEPTANCE_TEST.md TC-RA-01〜30)
 *
 * リリース判定の骨格となる「単一テナントのライフサイクル」を自動化する (🤖 部分)。
 *   1. /signup で層3 (完全新規) テナントを Beginner で払い出し、検証メール経由でログイン
 *      (初回ログインで自動表示される WelcomeOwlModal は fixture が dismiss 済)
 *   2. 主要資産 (project / knowledge / risk / issue / retrospective / memo) を作成・更新・削除
 *
 * 外部サービス前提:
 *   embedding (Voyage) は資産作成時に after() 非同期 + catch 握り込み (ADR-0026) のため、
 *   CI で VOYAGE_API_KEY 未設定でも資産 CRUD 自体は成功する (= スタブ不要)。
 *   チャット意味検索 / ヘルプ / 添付は別 spec (embedding/LLM スタブ前提) / 👤 人手スモークに分離。
 *
 * 後始末:
 *   afterAll で cleanupTenantByRunId(RUN_ID)。セルフ解約と異なり物理 purge するため、
 *   同 email が層1 として残らない (ローカル再実行のための後始末)。
 *
 * カバレッジ: docs/test/E2E_COVERAGE.md (/signup 完了 / /api/auth/signup / 各資産 CRUD)
 */

import { test, expect, type APIResponse, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import { signupTenantViaUi, type SignupResult } from '../fixtures/signup';
import { cleanupTenantByRunId, disconnectDb } from '../fixtures/db';
import { createProjectViaApi } from '../fixtures/project';

let context: BrowserContext;
let page: Page;
let tenant: SignupResult;
let projectId = '';

const PROJECT_NAME = withRunId('LCプロジェクト');
const KNOWLEDGE_TITLE = withRunId('LCナレッジ');
const KNOWLEDGE_TITLE_UPDATED = withRunId('LCナレッジ-更新');
const RISK_TITLE = withRunId('LCリスク');
const ISSUE_TITLE = withRunId('LC課題');
const RETRO_PLAN = withRunId('LC振り返り計画');
const MEMO_TITLE = withRunId('LCメモ');

/** 認証済 page.request で POST し、ok でなければ詳細付きで throw する。 */
async function postOk(p: Page, url: string, data: Record<string, unknown>): Promise<APIResponse> {
  const res = await p.request.post(url, { data });
  if (!res.ok()) {
    throw new Error(`POST ${url} failed: ${res.status()} ${await res.text()}`);
  }
  return res;
}

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:release-acceptance signup ライフサイクル (払い出し→全資産CRUD)', () => {
  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    // 層3 (完全新規) で Beginner テナントを払い出し、ログインまで完了 (オンボーディングは dismiss 済)
    tenant = await signupTenantViaUi(page, { label: 'lc', plan: 'beginner' });
  });

  test.afterAll(async () => {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await cleanupTenantByRunId(RUN_ID);
    await disconnectDb();
  });

  test('TC-RA-08: 払い出し後 /projects に着地し、初回オンボーディングは閉じている', async () => {
    await expect(page).toHaveURL(/\/projects/);
    // fixture が welcome-owl-close 済 = モーダルは非表示
    await expect(page.getByTestId('welcome-owl-modal')).toBeHidden();
  });

  test('TC-RA-20: プロジェクト作成 → /projects 一覧に表示', async () => {
    const created = await createProjectViaApi(page, { name: PROJECT_NAME });
    projectId = created.id;
    await page.goto('/projects');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(PROJECT_NAME)).toBeVisible({ timeout: 10_000 });
  });

  test('TC-RA-22: ナレッジ 作成 → 更新 → /knowledge 一覧に反映', async () => {
    // 作成 (project-scoped、visibility=public = 全メンバー公開 → 全ナレッジ一覧に出る)
    const res = await postOk(page, `/api/projects/${projectId}/knowledge`, {
      title: KNOWLEDGE_TITLE,
      knowledgeType: 'lesson',
      content: 'E2E ライフサイクル ナレッジ本文',
      visibility: 'public',
    });
    const knowledgeId = (await res.json()).data.id as string;

    await page.goto('/knowledge');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(KNOWLEDGE_TITLE)).toBeVisible({ timeout: 10_000 });

    // 更新 (タイトル変更が一覧に反映される)
    const upd = await page.request.patch(`/api/knowledge/${knowledgeId}`, {
      data: { title: KNOWLEDGE_TITLE_UPDATED },
    });
    expect(upd.ok()).toBeTruthy();
    await page.goto('/knowledge');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(KNOWLEDGE_TITLE_UPDATED)).toBeVisible({ timeout: 10_000 });
  });

  test('TC-RA-23/24: リスク + 課題 作成 → /risks /issues 一覧に反映', async () => {
    await postOk(page, `/api/projects/${projectId}/risks`, {
      type: 'risk',
      title: RISK_TITLE,
      content: 'E2E リスク本文',
      impact: 'medium',
      visibility: 'public',
    });
    await postOk(page, `/api/projects/${projectId}/risks`, {
      type: 'issue',
      title: ISSUE_TITLE,
      content: 'E2E 課題本文',
      impact: 'high',
      visibility: 'public',
    });

    await page.goto('/risks');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(RISK_TITLE)).toBeVisible({ timeout: 10_000 });

    await page.goto('/issues');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(ISSUE_TITLE)).toBeVisible({ timeout: 10_000 });
  });

  test('TC-RA-25: 振り返り 作成 → /retrospectives 一覧に反映', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await postOk(page, `/api/projects/${projectId}/retrospectives`, {
      conductedDate: today,
      planSummary: RETRO_PLAN,
      actualSummary: 'E2E 実績総括',
      visibility: 'public',
    });
    await page.goto('/retrospectives');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(RETRO_PLAN)).toBeVisible({ timeout: 10_000 });
  });

  test('TC-RA-26: メモ 作成 → /all-memos に表示 → 削除で一覧から消える', async () => {
    const res = await postOk(page, '/api/memos', {
      title: MEMO_TITLE,
      content: 'E2E メモ本文',
      visibility: 'public',
    });
    const memoId = (await res.json()).data.id as string;

    await page.goto('/all-memos');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(MEMO_TITLE)).toBeVisible({ timeout: 10_000 });

    // 削除 (CRUD の D を検証) → 一覧から消える
    const del = await page.request.delete(`/api/memos/${memoId}`);
    expect(del.ok()).toBeTruthy();
    await page.goto('/all-memos');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(MEMO_TITLE)).toHaveCount(0, { timeout: 10_000 });
  });
});
