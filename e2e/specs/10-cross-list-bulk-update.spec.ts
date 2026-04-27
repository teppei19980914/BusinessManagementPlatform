/**
 * E2E: 「全○○一覧」横断ビューからの一括更新 API (PR #161 / PR #162) の二重防御検証。
 *
 * カバー範囲:
 *   - /api/risks/bulk      (PATCH, PR #161)
 *   - /api/retrospectives/bulk (PATCH, PR #162 Phase 2)
 *   - /api/knowledge/bulk  (PATCH, PR #162 Phase 2)
 *   - /api/memos/bulk      (PATCH, PR #162 Phase 2)
 *
 * 検証観点 (DEVELOPER_GUIDE §5.21 / §5.22 で約束した二重防御の実環境エビデンス):
 *   1. **filterFingerprint 空 → 400 FILTER_REQUIRED**
 *      UI チェックボックス無効化を JS で剥がしても API 直叩きで弾かれることを保証する。
 *      これが本 spec の最重要シナリオ (unit test で固めたロジックが実環境の Prisma +
 *      middleware 経由でも機能することの最終確認)。
 *   2. **filterFingerprint 適用 → 200 OK** (構造的検証)
 *      実 DB 行を作らないため `skippedNotFound` にカウントされるが、レスポンス構造
 *      ({ updatedIds, skippedNotOwned, skippedNotFound }) と HTTP 200 が確認できる。
 *      行作成 + 実更新の検証は unit test (route.test.ts / service.test.ts) で網羅済。
 *
 * 設計判断: API レベル E2E のみを採用 (UI 経由の bulk 操作は filter 入力 / checkbox /
 * dialog の race が脆弱性源で §4.x で繰り返し対処したパターンのため、本 spec では
 * サーバ側の二重防御に焦点を絞る)。UI 表示ロジックは unit test (validator 15 + UI client
 * 内 props) で検証済。
 *
 * カバレッジ記録: docs/developer/E2E_COVERAGE.md で skip → [x] に変更する対応 PR。
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID } from '../fixtures/run-id';
import { ensureInitialAdmin, cleanupByRunId, disconnectDb } from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';

const ADMIN_EMAIL = `admin-pr161-bulk-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

// 実存しない UUID。bulk API は { skippedNotFound: 1 } を返すが構造は検証可能。
const FAKE_UUID = '550e8400-e29b-41d4-a716-446655440099';

let sharedContext: BrowserContext;
let sharedPage: Page;

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:cross-list-bulk PR #161/#162 横断ビュー一括更新 API 二重防御', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });

    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();

    await sharedPage.goto('/login');
    await sharedPage.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await sharedPage.getByLabel('パスワード').fill(ADMIN_PW);
    await sharedPage.getByRole('button', { name: 'ログイン' }).click();
    await waitForProjectsReady(sharedPage);
  });

  test.afterAll(async () => {
    await sharedPage.close();
    await sharedContext.close();
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  // -------- /api/risks/bulk (PR #161) --------

  test('PR #161: POST /api/risks/bulk filterFingerprint 空 → 400 FILTER_REQUIRED', async () => {
    const res = await sharedPage.request.patch('/api/risks/bulk', {
      data: {
        ids: [FAKE_UUID],
        filterFingerprint: {}, // 空: フィルター何も適用していない状態
        patch: { state: 'in_progress' },
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('FILTER_REQUIRED');
  });

  test('PR #161: POST /api/risks/bulk type=risk フィルター適用 → 200 OK (構造検証)', async () => {
    const res = await sharedPage.request.patch('/api/risks/bulk', {
      data: {
        ids: [FAKE_UUID],
        filterFingerprint: { type: 'risk' }, // タブ選択 = 暗黙のフィルター
        patch: { state: 'in_progress' },
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // 実存しない UUID なので skippedNotFound=1、updatedIds=[] が返る
    expect(body.data).toHaveProperty('updatedIds');
    expect(body.data).toHaveProperty('skippedNotOwned');
    expect(body.data).toHaveProperty('skippedNotFound');
    expect(body.data.skippedNotFound).toBe(1);
  });

  // -------- /api/retrospectives/bulk (PR #162) --------

  test('PR #162: POST /api/retrospectives/bulk filterFingerprint 空 → 400 FILTER_REQUIRED', async () => {
    const res = await sharedPage.request.patch('/api/retrospectives/bulk', {
      data: {
        ids: [FAKE_UUID],
        filterFingerprint: {},
        visibility: 'draft',
      },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('FILTER_REQUIRED');
  });

  test('PR #162: POST /api/retrospectives/bulk mineOnly=true → 200 OK', async () => {
    const res = await sharedPage.request.patch('/api/retrospectives/bulk', {
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

  // -------- /api/knowledge/bulk (PR #162) --------

  test('PR #162: POST /api/knowledge/bulk filterFingerprint 空 → 400 FILTER_REQUIRED', async () => {
    const res = await sharedPage.request.patch('/api/knowledge/bulk', {
      data: {
        ids: [FAKE_UUID],
        filterFingerprint: {},
        visibility: 'draft',
      },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('FILTER_REQUIRED');
  });

  test('PR #162: POST /api/knowledge/bulk keyword 適用 → 200 OK', async () => {
    const res = await sharedPage.request.patch('/api/knowledge/bulk', {
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

  // -------- /api/memos/bulk (PR #162) --------

  test('PR #162: POST /api/memos/bulk filterFingerprint 空 → 400 FILTER_REQUIRED', async () => {
    const res = await sharedPage.request.patch('/api/memos/bulk', {
      data: {
        ids: [FAKE_UUID],
        filterFingerprint: {},
        visibility: 'private',
      },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('FILTER_REQUIRED');
  });

  test('PR #162: POST /api/memos/bulk visibility=draft は 400 (Memo は private/public のみ)', async () => {
    // Memo は値域が他 entity (draft/public) と異なる。値域違反は 400 VALIDATION_ERROR。
    const res = await sharedPage.request.patch('/api/memos/bulk', {
      data: {
        ids: [FAKE_UUID],
        filterFingerprint: { mineOnly: true },
        visibility: 'draft', // Memo schema では未定義値
      },
    });
    expect(res.status()).toBe(400);
  });

  test('PR #162: POST /api/memos/bulk visibility=private + mineOnly → 200 OK', async () => {
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
});
