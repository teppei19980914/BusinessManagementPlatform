/**
 * E2E: 「○○一覧」(project-list / personal-list) からの一括更新 API の構造検証 (PR #165)。
 *
 * カバー範囲 (PR #161/#162 の cross-list 版から PR #165 で project-scoped に移し替え):
 *   - PATCH /api/projects/[projectId]/risks/bulk         (PR #161 → PR #165)
 *   - PATCH /api/projects/[projectId]/retrospectives/bulk (PR #162 → PR #165)
 *   - PATCH /api/projects/[projectId]/knowledge/bulk     (PR #162 → PR #165)
 *   - PATCH /api/memos/bulk                              (PR #162、personal scope なので path 維持)
 *
 * 検証観点:
 *   - **filterFingerprint の値の有無に関わらず 200 OK** (Phase C 要件 18, 2026-04-28):
 *     旧仕様の「filterFingerprint 空 → 400 FILTER_REQUIRED」は Phase C で撤廃。
 *     任意の複数行に対する一括編集を許可するため、フィルター必須要件を外す。
 *     誤更新は **per-row 作成者判定 (silent skip) + ids 上限 500 + projectId scope**
 *     で多層防御に集約。
 *   - **正常系**: 実存しない UUID を送り、レスポンス構造
 *     ({ updatedIds, skippedNotOwned, skippedNotFound }) と HTTP 200 を確認
 *     (skippedNotFound=1 で構造検証が完結)。
 *
 * カバレッジ記録: docs/developer/E2E_COVERAGE.md で 4 つの bulk endpoint を [x] にマップ。
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import { ensureInitialAdmin, cleanupByRunId, disconnectDb } from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';

const ADMIN_EMAIL = `admin-pr165-bulk-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

// 実存しない UUID。bulk API は { skippedNotFound: 1 } を返すが構造検証は完結する。
const FAKE_UUID = '550e8400-e29b-41d4-a716-446655440099';

let sharedContext: BrowserContext;
let sharedPage: Page;
let projectId = '';

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:project-list-bulk PR #165 「○○一覧」一括更新 API 二重防御', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });

    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();

    await sharedPage.goto('/login');
    await sharedPage.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await sharedPage.getByLabel('パスワード').fill(ADMIN_PW);
    await sharedPage.getByRole('button', { name: 'ログイン' }).click();
    await waitForProjectsReady(sharedPage);

    // セットアップ: customer 作成 → project 作成 (project-scoped bulk API には projectId が必要)
    const customerRes = await sharedPage.request.post('/api/customers', {
      data: {
        name: withRunId('PR165 検証顧客'),
        department: 'E2E',
        contactName: '担当',
      },
    });
    expect(customerRes.ok(), `customer create failed: ${customerRes.status()}`).toBeTruthy();
    const customerBody = await customerRes.json();
    const customerId = customerBody.data.id as string;

    const today = new Date().toISOString().split('T')[0];
    const in30 = new Date(Date.now() + 30 * 24 * 3600_000).toISOString().split('T')[0];
    const projectRes = await sharedPage.request.post('/api/projects', {
      data: {
        name: withRunId('PR165 検証プロジェクト'),
        customerId,
        purpose: 'PR #165 一括更新 API 検証',
        background: 'project-scoped 化後の二重防御確認',
        scope: 'API レベルのみ',
        devMethod: 'scratch',
        plannedStartDate: today,
        plannedEndDate: in30,
        businessDomainTags: [],
        techStackTags: [],
      },
    });
    expect(projectRes.ok(), `project create failed: ${projectRes.status()}`).toBeTruthy();
    const projectBody = await projectRes.json();
    projectId = projectBody.data.id;
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test.afterAll(async () => {
    await sharedPage.close();
    await sharedContext.close();
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  // -------- /api/projects/[projectId]/risks/bulk (PR #161 → PR #165) --------

  test('PATCH /api/projects/[projectId]/risks/bulk: filterFingerprint 空でも 200 (Phase C 要件 18)', async () => {
    const res = await sharedPage.request.patch(`/api/projects/${projectId}/risks/bulk`, {
      data: {
        ids: [FAKE_UUID],
        filterFingerprint: {},
        patch: { state: 'in_progress' },
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.skippedNotFound).toBe(1);
  });

  test('PATCH /api/projects/[projectId]/risks/bulk: type=risk フィルター → 200 OK (構造検証)', async () => {
    const res = await sharedPage.request.patch(`/api/projects/${projectId}/risks/bulk`, {
      data: {
        ids: [FAKE_UUID],
        filterFingerprint: { type: 'risk' },
        patch: { state: 'in_progress' },
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveProperty('updatedIds');
    expect(body.data).toHaveProperty('skippedNotOwned');
    expect(body.data).toHaveProperty('skippedNotFound');
    // 実存しない UUID なので skippedNotFound=1
    expect(body.data.skippedNotFound).toBe(1);
  });

  // -------- /api/projects/[projectId]/retrospectives/bulk (PR #162 → PR #165) --------

  test('PATCH /api/projects/[projectId]/retrospectives/bulk: filterFingerprint 空でも 200 (Phase C 要件 18)', async () => {
    const res = await sharedPage.request.patch(`/api/projects/${projectId}/retrospectives/bulk`, {
      data: {
        ids: [FAKE_UUID],
        filterFingerprint: {},
        visibility: 'draft',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.skippedNotFound).toBe(1);
  });

  test('PATCH /api/projects/[projectId]/retrospectives/bulk: mineOnly=true → 200 OK', async () => {
    const res = await sharedPage.request.patch(`/api/projects/${projectId}/retrospectives/bulk`, {
      data: {
        ids: [FAKE_UUID],
        filterFingerprint: { mineOnly: true },
        visibility: 'draft',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.skippedNotFound).toBe(1);
  });

  // -------- /api/projects/[projectId]/knowledge/bulk (PR #162 → PR #165) --------

  test('PATCH /api/projects/[projectId]/knowledge/bulk: filterFingerprint 空でも 200 (Phase C 要件 18)', async () => {
    const res = await sharedPage.request.patch(`/api/projects/${projectId}/knowledge/bulk`, {
      data: {
        ids: [FAKE_UUID],
        filterFingerprint: {},
        visibility: 'draft',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.skippedNotFound).toBe(1);
  });

  test('PATCH /api/projects/[projectId]/knowledge/bulk: keyword 適用 → 200 OK', async () => {
    const res = await sharedPage.request.patch(`/api/projects/${projectId}/knowledge/bulk`, {
      data: {
        ids: [FAKE_UUID],
        filterFingerprint: { keyword: 'react' },
        visibility: 'draft',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.skippedNotFound).toBe(1);
  });

  // -------- /api/memos/bulk (PR #162、PR #165 で path 維持) --------

  test('PATCH /api/memos/bulk: filterFingerprint 空でも 200 (Phase C 要件 18)', async () => {
    const res = await sharedPage.request.patch('/api/memos/bulk', {
      data: {
        ids: [FAKE_UUID],
        filterFingerprint: {},
        visibility: 'private',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.skippedNotFound).toBe(1);
  });

  test('PATCH /api/memos/bulk: visibility="draft" は 400 (Memo は private/public のみ)', async () => {
    const res = await sharedPage.request.patch('/api/memos/bulk', {
      data: {
        ids: [FAKE_UUID],
        filterFingerprint: { mineOnly: true },
        visibility: 'draft', // Memo schema では未定義値
      },
    });
    expect(res.status()).toBe(400);
  });

  test('PATCH /api/memos/bulk: visibility=private + mineOnly → 200 OK', async () => {
    const res = await sharedPage.request.patch('/api/memos/bulk', {
      data: {
        ids: [FAKE_UUID],
        filterFingerprint: { mineOnly: true },
        visibility: 'private',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.skippedNotFound).toBe(1);
  });

  // -------- 旧 cross-list path が削除されていることの確認 --------

  test('PR #165 で旧 path /api/risks/bulk は削除済 (Next.js は通常 405 を返す)', async () => {
    const res = await sharedPage.request.patch('/api/risks/bulk', {
      data: { ids: [FAKE_UUID], filterFingerprint: { type: 'risk' }, patch: { state: 'open' } },
    });
    // Next.js App Router は存在しない route handler に対して 404/405 を返す。
    expect([404, 405]).toContain(res.status());
  });
});
