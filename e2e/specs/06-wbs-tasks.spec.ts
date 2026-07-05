/**
 * E2E シナリオ: WBS 管理 (PR #96)
 *
 * カバー範囲:
 *   - /projects/[id]/tasks の WBS 管理画面が render される
 *   - Work Package (WP) + Activity (ACT) を API で作成、UI ツリー上に表示される
 *   - UI から task を削除 (confirm 承諾)
 *
 * 方針:
 *   - UI フォームは 10+ フィールドあり複雑なので **作成は API 経由** で軽量化
 *   - UI 側は「描画されているか」「削除操作が通るか」を検証
 *   - ドラッグ&ドロップは本プロダクトでは未実装 (drag lib 不使用) なので対象外
 *
 * 本プロダクト最複雑のクライアントコンポーネント (tasks-client.tsx) のため、
 * 本スコープでは happy path のみ。状態遷移 / 進捗更新 / CSV import-export は後続 PR。
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import {
  ensureInitialAdmin,
  ensureGeneralUser,
  cleanupByRunId,
  disconnectDb,
} from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';
import { createProjectViaApi, addProjectMemberViaApi } from '../fixtures/project';
import { snapshotStep } from '../fixtures/snapshot';

const ADMIN_EMAIL = `admin-pr96-wbs-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

const MEMBER_EMAIL = `${withRunId('pr96wbsmember')}@example.com`.toLowerCase();
const MEMBER_NAME = withRunId('PR96メンバー');
const MEMBER_PW = 'E2eMember!Pw_2026';

const PROJECT_NAME = withRunId('PR96WBSプロジェクト');
const WP_NAME = withRunId('WorkPackage-root');
const ACT_NAME = withRunId('Activity-child');

// ADR-0035: 一括削除 (bulk-delete + 末尾 recalculate) 検証用の専用 WP + 3 ACT
const WP_BULK_NAME = withRunId('WorkPackage-bulk');
const BULK_ACT_NAMES = [
  withRunId('BulkACT-1'),
  withRunId('BulkACT-2'),
  withRunId('BulkACT-3'),
];

let sharedContext: BrowserContext;
let sharedPage: Page;
let projectId = '';
let memberUserId = '';
let workPackageId = '';

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:project:wbs WBS 管理 (PR #96)', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });
    memberUserId = await ensureGeneralUser(MEMBER_EMAIL, MEMBER_NAME, MEMBER_PW);

    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();

    await sharedPage.goto('/login');
    // ADR-0016 (2026-05-20): 組織 ID 必須化
    await sharedPage.getByLabel('組織 ID').fill('default');
    await sharedPage.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await sharedPage.getByLabel('パスワード').fill(ADMIN_PW);
    await sharedPage.getByRole('button', { name: 'ログイン' }).click();
    await waitForProjectsReady(sharedPage);

    const { id } = await createProjectViaApi(sharedPage, { name: PROJECT_NAME });
    projectId = id;
    // ACT の担当者候補として member を追加
    await addProjectMemberViaApi(sharedPage, {
      projectId,
      userId: memberUserId,
      projectRole: 'member',
    });
  });

  test.afterAll(async () => {
    await sharedPage.close();
    await sharedContext.close();
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('/tasks 画面が render される (タブ active 確認)', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');
    // Phase A 要件 6 (2026-04-28): WBS管理 h2 タイトル削除に伴い、ボタンで render 検証していた。
    // 2026-04-30 (Task 1): Gantt は独立タブ化、トグルボタンは廃止。代わりに WBS タブ固有の
    //   「エクスポート」ボタンで render 検証する (admin/PM/TL に表示、空 WBS でも可視)。
    await expect(page.getByRole('button', { name: 'エクスポート' })).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'wbs-empty');
  });

  /**
   * fix/wbs-filter-regression: PR #128a-2 のモバイル対応で `<details className="md:open:">`
   * という壊れた Tailwind 記述を入れたため、PC でフィルタ (担当者 + 状況) が常時折りたたまれて
   * 表示されない degression が発生していた。再発防止として PC viewport で
   * フィルタ要素の可視性をチェックする回帰テストを追加。
   *
   * チェック内容:
   *   - 担当者ラベルの MultiSelectFilter ボタンが PC viewport で見える
   *   - 状況ラベルの MultiSelectFilter ボタンが PC viewport で見える
   *
   * モバイル (chromium-mobile) では本 spec が testIgnore 対象 (E2E_LESSONS_LEARNED §4.37)
   * のため PC のみで実行される。
   */
  test('WBS フィルタ (担当者 / 状況) が PC viewport で常時表示される (regression: PR #128a-2 で破壊された PC 表示)', async () => {
    const page = sharedPage;
    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');
    // MultiSelectFilter は <button>{label}: ...</button> を render するため、
    // ボタンの accessible name を「担当者:」「状況:」prefix で部分一致させる
    await expect(page.getByRole('button', { name: /^担当者:/ })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /^状況:/ })).toBeVisible({ timeout: 10_000 });
  });

  test('Work Package を API で作成 → UI ツリーに表示される', async () => {
    const page = sharedPage;
    const res = await page.request.post(`/api/projects/${projectId}/tasks`, {
      data: {
        type: 'work_package',
        name: WP_NAME,
      },
    });
    expect(res.ok(), `WP create: ${await res.text()}`).toBeTruthy();
    workPackageId = (await res.json()).data.id;

    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');
    // 一覧行は table row にスコープ + .first() (LESSONS_LEARNED §4.11)
    await expect(
      page.locator('tr').filter({ hasText: WP_NAME }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'wbs-with-wp');
  });

  test('Activity を WP 配下に API で作成 → UI ツリーに表示される', async () => {
    const page = sharedPage;
    const today = new Date().toISOString().slice(0, 10);
    const in7 = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const res = await page.request.post(`/api/projects/${projectId}/tasks`, {
      data: {
        type: 'activity',
        parentTaskId: workPackageId,
        name: ACT_NAME,
        assigneeId: memberUserId,
        plannedStartDate: today,
        plannedEndDate: in7,
        plannedEffort: 8,
        includeWeekends: true,
      },
    });
    expect(res.ok(), `ACT create: ${await res.text()}`).toBeTruthy();

    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');

    // WBS ツリーは WP を初期 collapsed 表示し、子 ACT は DOM から除外される
    // (tasks-client.tsx L297: `!isCollapsed && task.children?.map(...)`)。
    // ACT を検証する前に WP 行の展開トグル `▶` をクリックする。
    //
    // PR #96 hotfix 4 で tasks-client.tsx の展開ボタンに aria-label を追加
    // (Gantt 側と一貫化)。これにより getByRole('button', { name: ... }) で拾える。
    // 詳細は LESSONS_LEARNED §4.16 参照。
    const wpRow = page.locator('tr').filter({ hasText: WP_NAME });
    await wpRow.getByRole('button', { name: /展開|折りたたみ/ }).click();

    await expect(
      page.locator('tr').filter({ hasText: ACT_NAME }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await snapshotStep(page, 'wbs-with-wp-and-act');
  });

  /**
   * 2026-05-25 [A1+A2] WBS Sync-Import: 別 WP 配下の同名 ACT を許可する。
   *
   * 旧バグ: 同階層 (level=2) で同名のタスクは別親でも重複ブロッカーになり、
   *   「WPA/AACT, BACT」「WPB/AACT, BACT」のような実務的な CSV がインポートできなかった。
   *
   * 本テストは bug fix の golden path 検証:
   *   - 2 つの WP を API で作成
   *   - CSV (UTF-8 BOM 付) を作り、各 WP 配下に同名 ACT を 2 つずつ配置
   *   - dry-run で canExecute=true (ブロッカー 0)
   *   - 本実行で added=2 + WP 2件分の親 update
   *   - DB 上に 同名 ACT が 2 つ別 parent で作られていること
   */
  test('[Bug Fix] 別 WP 配下の同名 ACT を sync-import で作成できる (PR #wbs-import-uplift)', async () => {
    const page = sharedPage;

    // 既存 WP に加えてもう 1 つ WP を API で作成
    const wpBName = withRunId('WorkPackage-second');
    const wpBRes = await page.request.post(`/api/projects/${projectId}/tasks`, {
      data: { type: 'work_package', name: wpBName },
    });
    expect(wpBRes.ok(), `WP B create: ${await wpBRes.text()}`).toBeTruthy();
    const wpBId = (await wpBRes.json()).data.id;

    // CSV を構築 (BOM 付 UTF-8, 7 列):
    //   行 2: WP A (UPDATE, id=workPackageId)
    //   行 3: 共通レビュー (ACT, 新規, parent=WP A)
    //   行 4: WP B (UPDATE, id=wpBId)
    //   行 5: 共通レビュー (ACT, 新規, parent=WP B)  ← 同名だが別 WP 配下
    const BOM = '﻿';
    const header = 'ID,種別,名称,レベル,予定開始日,予定終了日,予定工数';
    const csv = [
      header,
      `${workPackageId},WP,${WP_NAME},1,,,`,
      `,ACT,共通レビュー,2,2026-06-01,2026-06-02,2`,
      `${wpBId},WP,${wpBName},1,,,`,
      `,ACT,共通レビュー,2,2026-06-03,2026-06-04,2`,
    ].join('\n');
    const csvBody = BOM + csv + '\n';

    // dry-run プレビュー
    const dryRes = await page.request.post(
      `/api/projects/${projectId}/tasks/sync-import?dryRun=1`,
      { multipart: { file: { name: 'wbs.csv', mimeType: 'text/csv', buffer: Buffer.from(csvBody, 'utf-8') } } },
    );
    expect(dryRes.ok(), `dry-run: ${await dryRes.text()}`).toBeTruthy();
    const dryJson = await dryRes.json();
    expect(dryJson.data.canExecute, `dry-run canExecute=true: ${JSON.stringify(dryJson.data.globalErrors)}`).toBe(true);
    expect(dryJson.data.summary.blockedErrors).toBe(0);
    expect(dryJson.data.summary.added).toBe(2); // 2 ACT 新規

    // 本実行 (snapshotAt を添えて OCC をパス)
    const applyRes = await page.request.post(
      `/api/projects/${projectId}/tasks/sync-import`,
      {
        headers: dryJson.data.snapshotAt ? { 'x-import-snapshot-at': dryJson.data.snapshotAt } : {},
        multipart: {
          file: { name: 'wbs.csv', mimeType: 'text/csv', buffer: Buffer.from(csvBody, 'utf-8') },
          removeMode: 'keep',
        },
      },
    );
    expect(applyRes.ok(), `apply: ${await applyRes.text()}`).toBeTruthy();
    const applyJson = await applyRes.json();
    expect(applyJson.data.added).toBe(2);

    // DB 上に同名 ACT が 2 つ別 parent で作られていることを API で確認
    const listRes = await page.request.get(`/api/projects/${projectId}/tasks`);
    expect(listRes.ok()).toBeTruthy();
    const list = await listRes.json();
    const samenameActs = (list.data ?? list).filter(
      (t: { name: string; type: string }) => t.name === '共通レビュー' && t.type === 'activity',
    );
    expect(samenameActs.length).toBe(2);
    const parents = new Set(samenameActs.map((t: { parentTaskId: string }) => t.parentTaskId));
    expect(parents.size).toBe(2); // 異なる parent 配下
  });

  /**
   * ADR-0037 (2026-06-09): WBS 上書きインポート apply のバッチ化 (504 タイムアウト解消)。
   *
   * 報告事象: 「追加 2 / 更新 100」のような **更新主体の大きめ WBS** を確定実行すると、
   *   per-row UPDATE (N 往復) + O(WP) 逐次再計算が Netlify 10 秒上限を超えて 504 になっていた。
   *   apply を「UPDATE の $transaction 配列バッチ + recalc のメモリ集計/一括書込」に変更した。
   *
   * 本テストは golden path 検証 (pure API, ページ状態は変更しない):
   *   1. 専用ルート WP を作成し、1st import で N 件の ACT を新規作成 (CREATE バッチ)
   *   2. 2nd import で N 件すべてを UPDATE (工数変更) + 新規 ACT 2 件 (= 報告パターンの再現)
   *   3. apply が完走し added=2 / updated>=N を返す
   *   4. **末尾の WP 集計再計算が正しく走り**、ルート WP の集計工数 = 子の合計になる
   */
  test('[ADR-0037] 追加+大量更新の混在 WBS 上書きインポートが完走し WP 集計が再計算される', async () => {
    const page = sharedPage;
    const BOM = '﻿';
    const header = 'ID,種別,名称,レベル,予定開始日,予定終了日,予定工数';
    const N = 40;
    const actName = (i: number) => withRunId(`BI-ACT-${i}`);

    // 専用ルート WP を API 作成 (他テストの名前フィルタと衝突しない独立名)
    const rootName = withRunId('BatchImport-root');
    const rootRes = await page.request.post(`/api/projects/${projectId}/tasks`, {
      data: { type: 'work_package', name: rootName },
    });
    expect(rootRes.ok(), `root WP: ${await rootRes.text()}`).toBeTruthy();
    const rootId = (await rootRes.json()).data.id;

    const postImport = async (csvBody: string, snapshotAt?: string | null) =>
      page.request.post(`/api/projects/${projectId}/tasks/sync-import`, {
        headers: snapshotAt ? { 'x-import-snapshot-at': snapshotAt } : {},
        multipart: {
          file: { name: 'wbs.csv', mimeType: 'text/csv', buffer: Buffer.from(csvBody, 'utf-8') },
          removeMode: 'keep',
        },
      });
    const dryImport = async (csvBody: string) =>
      page.request.post(`/api/projects/${projectId}/tasks/sync-import?dryRun=1`, {
        multipart: { file: { name: 'wbs.csv', mimeType: 'text/csv', buffer: Buffer.from(csvBody, 'utf-8') } },
      });

    // 1st import: ルート配下に N 件の ACT を新規作成 (各工数 1)
    const createCsv = BOM + [
      header,
      `${rootId},WP,${rootName},1,,,`,
      ...Array.from({ length: N }, (_, i) => `,ACT,${actName(i)},2,2026-06-01,2026-06-02,1`),
    ].join('\n') + '\n';

    const createDry = await dryImport(createCsv);
    expect(createDry.ok(), `create dry: ${await createDry.text()}`).toBeTruthy();
    const createDryJson = await createDry.json();
    expect(createDryJson.data.canExecute, JSON.stringify(createDryJson.data.globalErrors)).toBe(true);
    expect(createDryJson.data.summary.added).toBe(N);

    const createApply = await postImport(createCsv, createDryJson.data.snapshotAt);
    expect(createApply.ok(), `create apply: ${await createApply.text()}`).toBeTruthy();
    expect((await createApply.json()).data.added).toBe(N);

    // 作成した ACT の id を取得
    const list1 = await (await page.request.get(`/api/projects/${projectId}/tasks`)).json();
    const rows1 = (list1.data ?? list1) as Array<{
      id: string; name: string; type: string; parentTaskId: string | null;
    }>;
    const actIdByName = new Map(
      rows1.filter((t) => t.parentTaskId === rootId && t.type === 'activity').map((t) => [t.name, t.id]),
    );
    expect(actIdByName.size).toBe(N);

    // 2nd import: N 件すべて UPDATE (工数 1→3) + 新規 ACT 2 件 (工数 5)。報告された 504 パターン。
    const updateCsv = BOM + [
      header,
      `${rootId},WP,${rootName},1,,,`,
      ...Array.from({ length: N }, (_, i) =>
        `${actIdByName.get(actName(i))},ACT,${actName(i)},2,2026-06-01,2026-06-03,3`),
      `,ACT,${withRunId('BI-NEW-1')},2,2026-06-04,2026-06-05,5`,
      `,ACT,${withRunId('BI-NEW-2')},2,2026-06-04,2026-06-05,5`,
    ].join('\n') + '\n';

    const updDry = await dryImport(updateCsv);
    expect(updDry.ok(), `update dry: ${await updDry.text()}`).toBeTruthy();
    const updDryJson = await updDry.json();
    expect(updDryJson.data.canExecute, JSON.stringify(updDryJson.data.globalErrors)).toBe(true);
    expect(updDryJson.data.summary.added).toBe(2);

    const updApply = await postImport(updateCsv, updDryJson.data.snapshotAt);
    expect(updApply.ok(), `update apply: ${await updApply.text()}`).toBeTruthy();
    const updJson = await updApply.json();
    expect(updJson.data.added).toBe(2);
    expect(updJson.data.updated).toBeGreaterThanOrEqual(N); // N 件の ACT 更新 (+ WP 行)

    // 末尾の WP 集計再計算 (バッチ化版) が正しく走る: 集計工数 = N*3 + 2*5
    const list2 = await (await page.request.get(`/api/projects/${projectId}/tasks`)).json();
    const rows2 = (list2.data ?? list2) as Array<{ id: string; plannedEffort: number }>;
    const rootAfter = rows2.find((t) => t.id === rootId);
    expect(Number(rootAfter?.plannedEffort)).toBe(N * 3 + 2 * 5);
  });

  test('Activity を UI から削除できる (confirm 承諾)', async () => {
    const page = sharedPage;
    // /tasks ページが開いている前提 (直前 test の状態)

    // LESSONS §4.20/§4.26: 削除 click は router.refresh() の fire-and-forget と
    // dialog 承諾非同期で race する。DELETE API を click **前**に予約 → await、
    // 続けて page.reload で DB 真の状態を強制取得してから count 0 を assert する。
    // page.once('dialog') は click より前に登録しておく必要がある (alert/confirm は同期的 + microtask)。
    const deleteRes = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/projects/${projectId}/tasks/`)
        && r.request().method() === 'DELETE',
    );
    page.once('dialog', (dialog) => dialog.accept());

    // 対象 ACT 行の aria-label="削除" ボタン
    const actRow = page.locator('tr').filter({ hasText: ACT_NAME });
    await actRow.getByRole('button', { name: '削除' }).click();

    const res = await deleteRes;
    expect(res.ok(), `Activity DELETE failed: ${res.status()}`).toBeTruthy();

    // DB は更新済み。router.refresh() race を回避して UI を DB 真状態に強制同期。
    await page.reload({ waitUntil: 'networkidle' });

    await expect(page.locator('tr').filter({ hasText: ACT_NAME })).toHaveCount(0, {
      timeout: 10_000,
    });
    await snapshotStep(page, 'wbs-after-act-delete');
  });

  /**
   * ADR-0035: 複数 ACT を UI のチェックボックスで選択し「一括削除」。
   *
   * 検証:
   *   - 旧逐次ループではなく `POST /tasks/bulk-delete` 1 リクエストで削除される (deletedCount=3)
   *   - 削除後に `POST /tasks/recalculate` が 1 回呼ばれ、親 WP の集計 (plannedEffort) が 0 に戻る
   *     (= 末尾集約の recalculate が実際に走ったことの証跡)
   *   - UI 上で 3 ACT が消え、親 WP は残る
   *
   * 注: 一括選択バー / 行チェックボックスは PC テーブル前提 (`hidden md:flex` / mobile 非表示)。
   *   本 spec は chromium-mobile では testIgnore 済 (playwright.config.ts) のため PC のみで実行。
   */
  test('複数 Activity を UI から一括削除できる (ADR-0035: bulk-delete + 末尾 recalculate)', async () => {
    const page = sharedPage;

    // 一括削除用に専用 WP + 3 ACT を API で作成 (UI フォームは重いので作成は API、各 ACT 工数 4)
    const wpRes = await page.request.post(`/api/projects/${projectId}/tasks`, {
      data: { type: 'work_package', name: WP_BULK_NAME },
    });
    expect(wpRes.ok(), `bulk WP create: ${await wpRes.text()}`).toBeTruthy();
    const wpBulkId = (await wpRes.json()).data.id;

    const today = new Date().toISOString().slice(0, 10);
    const in7 = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const name of BULK_ACT_NAMES) {
      const r = await page.request.post(`/api/projects/${projectId}/tasks`, {
        data: {
          type: 'activity',
          parentTaskId: wpBulkId,
          name,
          assigneeId: memberUserId,
          plannedStartDate: today,
          plannedEndDate: in7,
          plannedEffort: 4,
        },
      });
      expect(r.ok(), `bulk ACT create ${name}: ${await r.text()}`).toBeTruthy();
    }

    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');

    // WP を展開して子 ACT を DOM に出す
    const wpRow = page.locator('tr').filter({ hasText: WP_BULK_NAME });
    await wpRow.getByRole('button', { name: /展開|折りたたみ/ }).click();

    // 3 つの ACT 行のチェックボックスを選択
    for (const name of BULK_ACT_NAMES) {
      const row = page.locator('tr').filter({ hasText: name });
      await expect(row.first()).toBeVisible({ timeout: 10_000 });
      await row.locator('input[type="checkbox"]').check();
    }

    // 一括選択バーに「3 件選択中」(PC viewport: hidden md:flex で表示)
    await expect(page.getByText('3 件選択中')).toBeVisible({ timeout: 10_000 });

    // 一括削除: confirm 承諾 + bulk-delete / recalculate の 2 POST を予約 → await
    // (LESSONS §4.20: dialog 登録は click より前。fire-and-forget の race を予約で回避)
    const bulkDeleteRes = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/projects/${projectId}/tasks/bulk-delete`)
        && r.request().method() === 'POST',
    );
    const recalcRes = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/projects/${projectId}/tasks/recalculate`)
        && r.request().method() === 'POST',
    );
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '一括削除', exact: true }).click();

    const delRes = await bulkDeleteRes;
    expect(delRes.ok(), `bulk-delete failed: ${delRes.status()} ${await delRes.text()}`).toBeTruthy();
    expect((await delRes.json()).data.deletedCount).toBe(3);

    // 末尾 recalculate が 1 回走る (ADR-0035 の WP 集計末尾集約)
    const recRes = await recalcRes;
    expect(recRes.ok(), `recalculate failed: ${recRes.status()}`).toBeTruthy();

    // DB 真状態へ強制同期 (router.refresh race 回避)
    await page.reload({ waitUntil: 'networkidle' });

    // 3 ACT は UI から消え、親 WP は残る
    for (const name of BULK_ACT_NAMES) {
      await expect(page.locator('tr').filter({ hasText: name })).toHaveCount(0, { timeout: 10_000 });
    }
    await expect(page.locator('tr').filter({ hasText: WP_BULK_NAME }).first()).toBeVisible();

    // API でも検証: 子 ACT が全削除され、末尾 recalculate により WP の集計工数が 0 に戻る
    const listRes = await page.request.get(`/api/projects/${projectId}/tasks`);
    expect(listRes.ok()).toBeTruthy();
    const list = await listRes.json();
    const rows = (list.data ?? list) as Array<{
      id: string;
      name: string;
      type: string;
      plannedEffort: number;
    }>;
    const remainingBulkActs = rows.filter((t) => BULK_ACT_NAMES.includes(t.name));
    expect(remainingBulkActs.length).toBe(0);
    const wpAfter = rows.find((t) => t.id === wpBulkId);
    expect(wpAfter?.plannedEffort).toBe(0);

    await snapshotStep(page, 'wbs-after-bulk-delete');
  });

  /**
   * ADR-0035: 一括更新の再計算 (recalculateAffectedWps) を end-to-end で検証する。
   *
   * 2 階層 WP (root → child) + child 配下に 2 ACT を作り、ACT の予定工数を一括更新すると、
   * child WP と root WP の集計工数が「影響 WP 集合 (親 ∪ 祖先) を深度降順で 1 回ずつ再計算」
   * する recalculateAffectedWps により正しく伝播することを確認する (祖先まで伝わるのが要点)。
   *
   * 方針 (本 spec 冒頭の方針に準拠):
   *   - 一括選択 → 「一括編集」ダイアログが開くことは UI で確認 (配線検証)。
   *   - 一括更新の値入力 (NumberInput は blur コミットで E2E が脆い) と集計検証は、認証済み
   *     page.request で bulk-update API を叩く end-to-end 経路 (middleware→route→service→DB) で行う。
   */
  test('複数 Activity の一括更新で親・祖先 WP の集計が再計算される (ADR-0035: recalculateAffectedWps)', async () => {
    const page = sharedPage;
    const rootName = withRunId('BU-root-WP');
    const childName = withRunId('BU-child-WP');
    const actNames = [withRunId('BU-ACT-1'), withRunId('BU-ACT-2')];

    // root WP → child WP (2 階層)
    const rootRes = await page.request.post(`/api/projects/${projectId}/tasks`, {
      data: { type: 'work_package', name: rootName },
    });
    expect(rootRes.ok(), `root WP: ${await rootRes.text()}`).toBeTruthy();
    const rootId = (await rootRes.json()).data.id;
    const childRes = await page.request.post(`/api/projects/${projectId}/tasks`, {
      data: { type: 'work_package', name: childName, parentTaskId: rootId },
    });
    expect(childRes.ok(), `child WP: ${await childRes.text()}`).toBeTruthy();
    const childId = (await childRes.json()).data.id;

    // child 配下に 2 ACT (各 plannedEffort 4)
    const today = new Date().toISOString().slice(0, 10);
    const in7 = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const actIds: string[] = [];
    for (const nm of actNames) {
      const r = await page.request.post(`/api/projects/${projectId}/tasks`, {
        data: {
          type: 'activity',
          parentTaskId: childId,
          name: nm,
          assigneeId: memberUserId,
          plannedStartDate: today,
          plannedEndDate: in7,
          plannedEffort: 4,
        },
      });
      expect(r.ok(), `ACT ${nm}: ${await r.text()}`).toBeTruthy();
      actIds.push((await r.json()).data.id);
    }

    const effortOf = async (id: string): Promise<number> => {
      const listRes = await page.request.get(`/api/projects/${projectId}/tasks`);
      const list = await listRes.json();
      const rows = (list.data ?? list) as Array<{ id: string; plannedEffort: number }>;
      return rows.find((t) => t.id === id)!.plannedEffort;
    };

    // 作成直後の集計 (createTask の recalculateAncestors 経由): child=8, root=8
    expect(await effortOf(childId)).toBe(8);
    expect(await effortOf(rootId)).toBe(8);

    // UI 配線: 2 ACT を選択 → 「一括編集」ダイアログが開く
    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');
    await page.locator('tr').filter({ hasText: rootName })
      .getByRole('button', { name: /展開|折りたたみ/ }).click();
    await page.locator('tr').filter({ hasText: childName })
      .getByRole('button', { name: /展開|折りたたみ/ }).click();
    for (const nm of actNames) {
      const row = page.locator('tr').filter({ hasText: nm });
      await expect(row.first()).toBeVisible({ timeout: 10_000 });
      await row.locator('input[type="checkbox"]').check();
    }
    await expect(page.getByText('2 件選択中')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: '一括編集', exact: true }).click();
    await expect(page.getByText('一括編集（2 件）')).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');

    // 一括更新本体は API で (NumberInput の blur コミット race を避け、集計再計算を確実に検証)
    const patchRes = await page.request.patch(`/api/projects/${projectId}/tasks/bulk-update`, {
      data: { taskIds: actIds, plannedEffort: 10 },
    });
    expect(patchRes.ok(), `bulk-update: ${await patchRes.text()}`).toBeTruthy();
    expect((await patchRes.json()).data.updatedCount).toBe(2);

    // recalculateAffectedWps により child=20, root=20 (深度降順で親 → 祖先まで 1 回ずつ伝播)
    expect(await effortOf(childId)).toBe(20);
    expect(await effortOf(rootId)).toBe(20);
  });

  /**
   * 単一タスク更新 (updateTask) を end-to-end で検証する。
   *   - ステータスを「完了」にすると進捗率が 100 に正規化される (PR #69 整合性ルール)。
   *   - 親 WP の集計 (進捗・状況) も recalculateAncestors で再計算される。
   * findUnique 統合 (ADR-0035) 後の updateTask 経路を通す。
   *
   * 方針: 編集ダイアログが開くことは UI で確認。値更新と集計検証は認証済み page.request で
   *   PATCH /tasks/[taskId] を叩く end-to-end 経路で行う。
   */
  test('単一 Activity 更新でステータス整合 + 親 WP 集計が再計算される (updateTask)', async () => {
    const page = sharedPage;
    const wpName = withRunId('SU-WP');
    const actName = withRunId('SU-ACT');

    const wpRes = await page.request.post(`/api/projects/${projectId}/tasks`, {
      data: { type: 'work_package', name: wpName },
    });
    expect(wpRes.ok(), `SU WP: ${await wpRes.text()}`).toBeTruthy();
    const wpId = (await wpRes.json()).data.id;

    const today = new Date().toISOString().slice(0, 10);
    const in7 = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const actRes = await page.request.post(`/api/projects/${projectId}/tasks`, {
      data: {
        type: 'activity',
        parentTaskId: wpId,
        name: actName,
        assigneeId: memberUserId,
        plannedStartDate: today,
        plannedEndDate: in7,
        plannedEffort: 6,
      },
    });
    expect(actRes.ok(), `SU ACT: ${await actRes.text()}`).toBeTruthy();
    const actId = (await actRes.json()).data.id;

    // UI 配線: 行の「編集」ボタンで編集ダイアログが開く
    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');
    await page.locator('tr').filter({ hasText: wpName })
      .getByRole('button', { name: /展開|折りたたみ/ }).click();
    const actRow = page.locator('tr').filter({ hasText: actName });
    await expect(actRow.first()).toBeVisible({ timeout: 10_000 });
    await actRow.getByRole('button', { name: '編集' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');

    // 値更新は API で: status=completed → updateTask が progress=100 に正規化
    const patchRes = await page.request.patch(`/api/projects/${projectId}/tasks/${actId}`, {
      data: { status: 'completed', actualEffort: 1 },
    });
    expect(patchRes.ok(), `single update: ${await patchRes.text()}`).toBeTruthy();
    const updated = (await patchRes.json()).data;
    expect(updated.status).toBe('completed');
    expect(updated.progressRate).toBe(100); // PR #69 整合性ルール (status=completed → 100%)

    // 親 WP の集計も再計算される (子 ACT が 1 件のみで完了 → WP も完了・100%)
    const listRes = await page.request.get(`/api/projects/${projectId}/tasks`);
    const list = await listRes.json();
    const rows = (list.data ?? list) as Array<{ id: string; status: string; progressRate: number }>;
    const wp = rows.find((t) => t.id === wpId)!;
    expect(wp.progressRate).toBe(100);
    expect(wp.status).toBe('completed');
  });

  /**
   * feat/url-autolink: タスクの説明に入力した http/https URL が表示時に「URL 部分だけ」
   *   リンク化されることを検証する。特に日本語が URL 直後に空白なしで続くケース
   *   ("https://example.com/specにアクセス…") で、日本語を href に巻き込まず URL のみが
   *   リンクになること (本機能の肝) を確認する。
   */
  test('説明のプレビューで日本語密着 URL が URL 部分のみリンク化される (feat/url-autolink)', async () => {
    const page = sharedPage;
    const wpName = withRunId('URL-WP');
    const actName = withRunId('URL-ACT');
    const today = new Date().toISOString().slice(0, 10);
    const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

    const wpRes = await page.request.post(`/api/projects/${projectId}/tasks`, {
      data: { type: 'work_package', name: wpName },
    });
    expect(wpRes.ok(), `WP: ${await wpRes.text()}`).toBeTruthy();
    const urlWpId = (await wpRes.json()).data.id;

    const actRes = await page.request.post(`/api/projects/${projectId}/tasks`, {
      data: {
        type: 'activity',
        parentTaskId: urlWpId,
        name: actName,
        assigneeId: memberUserId,
        plannedStartDate: today,
        plannedEndDate: in7,
        plannedEffort: 4,
        description: '詳細は https://example.com/specにアクセスしてください。',
      },
    });
    expect(actRes.ok(), `ACT: ${await actRes.text()}`).toBeTruthy();

    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');
    await page.locator('tr').filter({ hasText: wpName })
      .getByRole('button', { name: /展開|折りたたみ/ }).click();
    const actRow = page.locator('tr').filter({ hasText: actName });
    await expect(actRow.first()).toBeVisible({ timeout: 10_000 });
    await actRow.getByRole('button', { name: '編集' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });

    // 説明フィールドのプレビューを開く
    const descField = page.getByTestId('task-edit-field-description');
    await descField.getByRole('button', { name: 'プレビュー' }).click();

    // URL 部分だけがリンク化される (href に日本語を含まない)
    const link = descField.getByRole('link', { name: 'https://example.com/spec' });
    await expect(link).toBeVisible({ timeout: 10_000 });
    await expect(link).toHaveAttribute('href', 'https://example.com/spec');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    // 日本語を巻き込んだ壊れたリンクが存在しないこと
    await expect(descField.locator('a[href*="アクセス"]')).toHaveCount(0);
    // 日本語部分はテキストとして残る
    await expect(descField).toContainText('にアクセスしてください');

    await page.keyboard.press('Escape');
  });

  /**
   * feat/url-autolink: 新設した備考(notes)欄が編集ダイアログで保存→再オープンしても
   *   永続することを検証する (読み書き経路の end-to-end)。
   */
  test('備考(notes)を編集ダイアログで更新→再オープンで永続する (feat/url-autolink)', async () => {
    const page = sharedPage;
    const wpName = withRunId('Notes-WP');
    const actName = withRunId('Notes-ACT');
    const today = new Date().toISOString().slice(0, 10);
    const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

    const wpRes = await page.request.post(`/api/projects/${projectId}/tasks`, {
      data: { type: 'work_package', name: wpName },
    });
    expect(wpRes.ok(), `WP: ${await wpRes.text()}`).toBeTruthy();
    const notesWpId = (await wpRes.json()).data.id;

    const actRes = await page.request.post(`/api/projects/${projectId}/tasks`, {
      data: {
        type: 'activity',
        parentTaskId: notesWpId,
        name: actName,
        assigneeId: memberUserId,
        plannedStartDate: today,
        plannedEndDate: in7,
        plannedEffort: 4,
      },
    });
    expect(actRes.ok(), `ACT: ${await actRes.text()}`).toBeTruthy();

    const newNotes = '更新メモ https://example.com/updated';

    await page.goto(`/projects/${projectId}/tasks`);
    await page.waitForLoadState('networkidle');
    await page.locator('tr').filter({ hasText: wpName })
      .getByRole('button', { name: /展開|折りたたみ/ }).click();
    const actRow = page.locator('tr').filter({ hasText: actName });
    await expect(actRow.first()).toBeVisible({ timeout: 10_000 });
    await actRow.getByRole('button', { name: '編集' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('task-edit-field-notes').getByRole('textbox').fill(newNotes);
    await page.getByRole('dialog').getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 10_000 });

    // 再オープンして備考が永続していること
    await actRow.getByRole('button', { name: '編集' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByTestId('task-edit-field-notes').getByRole('textbox'),
    ).toHaveValue(newNotes, { timeout: 10_000 });

    await page.keyboard.press('Escape');
  });

  /**
   * ADR-0035 (2026-06-12): WBS 一括更新の件数制限撤廃検証。
   *
   * 旧実装: schema に `.max(100)` があり 101 件以上を 1 リクエストで送ると 400 になっていた。
   * 新実装: クライアントは runChunkedBulk (chunkSize:100, concurrency:3) で分割送信するため
   *   100 件超でもチャンクごとに成功し、全件更新される。
   *
   * 本テストでは 2 WP × 各 60 ACT = 120 件を API で一括作成し、
   *   bulk-update API を 2 回 (60 件ずつ) 呼ぶ「チャンク分割シミュレーション」で
   *   全 120 件の plannedEffort が更新され、各親 WP の集計値も連動することを確認する。
   *   (フロントエンドの runChunkedBulk は E2E から直接実行不可のため、
   *    同等のチャンク分割を page.request で再現する)
   */
  test('120 件の Activity を 2 チャンクに分けて一括更新できる (ADR-0035: 件数制限撤廃)', async () => {
    const page = sharedPage;
    const CHUNK = 60;
    const today = new Date().toISOString().slice(0, 10);
    const in14 = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

    // 2 WP + 各 60 ACT (= 計 120 ACT) を API で作成
    const actIds: string[] = [];
    for (let w = 0; w < 2; w++) {
      const wpRes = await page.request.post(`/api/projects/${projectId}/tasks`, {
        data: { type: 'work_package', name: withRunId(`Chunk-WP-${w}`) },
      });
      expect(wpRes.ok(), `chunk WP ${w}: ${await wpRes.text()}`).toBeTruthy();
      const wpId = (await wpRes.json()).data.id;

      for (let a = 0; a < CHUNK; a++) {
        const actRes = await page.request.post(`/api/projects/${projectId}/tasks`, {
          data: {
            type: 'activity',
            parentTaskId: wpId,
            name: withRunId(`Chunk-ACT-${w}-${a}`),
            assigneeId: memberUserId,
            plannedStartDate: today,
            plannedEndDate: in14,
            plannedEffort: 2,
          },
        });
        expect(actRes.ok(), `chunk ACT ${w}-${a}: ${await actRes.text()}`).toBeTruthy();
        actIds.push((await actRes.json()).data.id);
      }
    }
    expect(actIds).toHaveLength(120);

    // チャンク 1: ids[0..59] → 60 件を 1 リクエスト
    const res1 = await page.request.patch(`/api/projects/${projectId}/tasks/bulk-update`, {
      data: { taskIds: actIds.slice(0, CHUNK), plannedEffort: 5 },
    });
    expect(res1.ok(), `chunk1 bulk-update: ${await res1.text()}`).toBeTruthy();
    expect((await res1.json()).data.updatedCount).toBe(CHUNK);

    // チャンク 2: ids[60..119] → 60 件を 1 リクエスト
    const res2 = await page.request.patch(`/api/projects/${projectId}/tasks/bulk-update`, {
      data: { taskIds: actIds.slice(CHUNK), plannedEffort: 5 },
    });
    expect(res2.ok(), `chunk2 bulk-update: ${await res2.text()}`).toBeTruthy();
    expect((await res2.json()).data.updatedCount).toBe(CHUNK);

    // 全 120 件が plannedEffort=5 に更新されていることを API で確認
    const listRes = await page.request.get(`/api/projects/${projectId}/tasks`);
    const list = (await listRes.json()) as { data: Array<{ id: string; plannedEffort: number | null }> };
    const tasks = list.data ?? (list as unknown as Array<{ id: string; plannedEffort: number | null }>);
    const actSet = new Set(actIds);
    const updated = tasks.filter((t) => actSet.has(t.id));
    expect(updated).toHaveLength(120);
    expect(updated.every((t) => t.plannedEffort === 5)).toBe(true);
  });
});
