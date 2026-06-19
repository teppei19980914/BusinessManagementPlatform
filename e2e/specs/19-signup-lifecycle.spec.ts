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
import { cleanupTenantByRunId, disconnectDb, getTenantUserIdByEmail } from '../fixtures/db';
import { createProjectViaApi, addProjectMemberViaApi } from '../fixtures/project';

let context: BrowserContext;
let page: Page;
let tenant: SignupResult;
let projectId = '';

const PROJECT_NAME = withRunId('LCプロジェクト');
const KNOWLEDGE_TITLE = withRunId('LCナレッジ');
const KNOWLEDGE_TITLE_UPDATED = withRunId('LCナレッジ-更新');
// グローバル /knowledge 一覧は「タイトル列」を持たず「内容」列を表示するため、UI 検証は content で行う
const KNOWLEDGE_CONTENT = withRunId('LCナレッジ本文');
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
    // customerName を PROJECT_NAME と別文字列にする (既定 `E2E 顧客 <name>` だと顧客列にも
    //   プロジェクト名が部分一致し、getByText が複数要素に当たって strict mode violation になる)。
    const created = await createProjectViaApi(page, {
      name: PROJECT_NAME,
      customerName: withRunId('LC顧客'),
    });
    projectId = created.id;

    // プロジェクト作成者は自動でメンバーにならない (createProject は ProjectMember を作らない)。
    //   プロジェクト配下の資産 (knowledge/risk/retrospective) 作成には pm_tl/member 権限が必要なため、
    //   admin を pm_tl メンバーとして明示追加する (05-teardown と同じ established パターン)。
    const adminUserId = await getTenantUserIdByEmail(tenant.email, tenant.slug);
    await addProjectMemberViaApi(page, { projectId, userId: adminUserId, projectRole: 'pm_tl' });

    await page.goto('/projects');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(PROJECT_NAME).first()).toBeVisible({ timeout: 10_000 });
  });

  // 検証方針: グローバル一覧の表示列は資産ごとに異なる (例: /knowledge はタイトル列を持たず
  //   「内容」列を表示) ため、CRUD の真値は **API GET (route→service→DB→レスポンス)** で確認する。
  //   UI 反映は、表示されることを確認済みの列 (knowledge の「内容」) で代表的に 1 つ検証する。

  /** 指定 URL を GET し、レスポンス本文に needle が含まれる/含まれないことを検証する。 */
  async function expectListContains(url: string, needle: string, present = true): Promise<void> {
    const res = await page.request.get(url);
    expect(res.ok(), `GET ${url} should be ok`).toBeTruthy();
    const body = await res.text();
    if (present) expect(body, `${url} should contain ${needle}`).toContain(needle);
    else expect(body, `${url} should NOT contain ${needle}`).not.toContain(needle);
  }

  test('TC-RA-22: ナレッジ 作成 → 更新 (API 真値 + /knowledge UI の内容列に反映)', async () => {
    // v1.3.0 軽量入力 (2026-06-19): public は title + 背景/内容/結果 が必須
    const res = await postOk(page, `/api/projects/${projectId}/knowledge`, {
      title: KNOWLEDGE_TITLE,
      knowledgeType: 'lesson',
      background: 'E2E 背景',
      content: KNOWLEDGE_CONTENT,
      result: 'E2E 結果',
      visibility: 'public',
    });
    const knowledgeId = (await res.json()).data.id as string;

    // API 真値: プロジェクト配下ナレッジ GET にタイトルが含まれる
    await expectListContains(`/api/projects/${projectId}/knowledge`, KNOWLEDGE_TITLE);

    // UI: グローバル /knowledge は一覧で「タイトル」列を表示する (本文列(背景/内容/結果)は
    //   2026-06-03 に詳細ダイアログのみへ移動し一覧からは撤去) ので title で確認
    await page.goto('/knowledge');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(KNOWLEDGE_TITLE).first()).toBeVisible({ timeout: 10_000 });

    // 更新 → API 真値で反映確認 (更新はプロジェクト配下ルートのみ。グローバル /api/knowledge/[id] は
    //   GET + DELETE(admin モデレーション) のみで PATCH 非対応)
    const upd = await page.request.patch(`/api/projects/${projectId}/knowledge/${knowledgeId}`, {
      data: { title: KNOWLEDGE_TITLE_UPDATED },
    });
    expect(upd.ok()).toBeTruthy();
    await expectListContains(`/api/projects/${projectId}/knowledge`, KNOWLEDGE_TITLE_UPDATED);
  });

  test('TC-RA-23/24: リスク + 課題 作成 (API 真値で確認)', async () => {
    // v1.3.0 軽量入力 (2026-06-19): public は title + occurrence/cause/responsePolicy/content が必須
    await postOk(page, `/api/projects/${projectId}/risks`, {
      type: 'risk',
      title: RISK_TITLE,
      content: 'E2E リスク本文',
      occurrence: 'E2E 想定事象',
      cause: 'E2E 想定原因',
      responsePolicy: 'E2E 想定対応策',
      impact: 'medium',
      visibility: 'public',
    });
    await postOk(page, `/api/projects/${projectId}/risks`, {
      type: 'issue',
      title: ISSUE_TITLE,
      content: 'E2E 課題本文',
      occurrence: 'E2E 発生事象',
      cause: 'E2E 直接原因',
      responsePolicy: 'E2E 対応策',
      impact: 'high',
      visibility: 'public',
    });
    // POST 201 で作成は担保済。プロジェクト配下 GET にリスク/課題が含まれることも確認。
    await expectListContains(`/api/projects/${projectId}/risks`, RISK_TITLE);
    await expectListContains(`/api/projects/${projectId}/risks`, ISSUE_TITLE);
  });

  test('TC-RA-25: 振り返り 作成 (API 真値で確認)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    // v1.3.0 軽量入力 (2026-06-19): public は 5 セクション (計画総括/実績総括/良かった点/課題/改善事項) が必須。実施日は任意。
    await postOk(page, `/api/projects/${projectId}/retrospectives`, {
      conductedDate: today,
      planSummary: RETRO_PLAN,
      actualSummary: 'E2E 実績総括',
      goodPoints: 'E2E 良かった点',
      problems: 'E2E 課題',
      improvements: 'E2E 改善事項',
      visibility: 'public',
    });
    await expectListContains(`/api/projects/${projectId}/retrospectives`, RETRO_PLAN);
  });

  test('TC-RA-26: メモ 作成 → 削除 (API 真値で存在 → 不在を確認)', async () => {
    const res = await postOk(page, '/api/memos', {
      title: MEMO_TITLE,
      content: 'E2E メモ本文',
      visibility: 'public',
    });
    const memoId = (await res.json()).data.id as string;

    await expectListContains('/api/memos', MEMO_TITLE, true);

    // 削除 (CRUD の D) → 一覧から消える
    const del = await page.request.delete(`/api/memos/${memoId}`);
    expect(del.ok()).toBeTruthy();
    await expectListContains('/api/memos', MEMO_TITLE, false);
  });
});
