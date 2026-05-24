/**
 * E2E: カラムソート dropdown の可視性 (PR fix/sortable-header-dropdown-portal / 2026-05-24)
 *
 * カバー範囲:
 *   一覧画面の sortable-header-button をクリックしたとき、ソート選択メニュー
 *   (↑昇順 / ↓降順 / ×クリア) が **可視** な状態で表示されること。
 *
 * 背景:
 *   PR feat/sortable-columns (2026-05-01) で全 13 一覧画面にカラムソート機能を導入したが、
 *   親 `ResizableHead` の `<div className="truncate pr-2">` が `overflow: hidden` を持つため
 *   (Tailwind `truncate` ユーティリティの定義), 絶対配置の dropdown が **content box で
 *   クリップされて完全不可視** = ユーザは項目選択不能 = ソート機能完全 dead 化していた。
 *
 *   単体テスト (multi-sort.test.ts) は純粋関数のみカバーで、UI 統合の盲点として検知不能。
 *   本 spec は「state 更新は成功するが視覚的に隠れる UI バグ」の再発を防ぐ E2E ガード。
 *
 * 対策実装:
 *   src/components/sort/sortable-header.tsx の dropdown を `createPortal(<ul>, document.body)`
 *   で body 直下に出す Portal 化。任意祖先の overflow から独立する。
 *
 * 検証ポイント:
 *   1. trigger button をクリックすると menu が可視 (toBeVisible)
 *   2. menu が `<body>` 直下にレンダーされている (Portal が機能している証拠)
 *      = `body > [data-testid="sortable-header-menu"]` セレクタで取得できる
 *   3. menu 内の「昇順」「降順」menuitem が可視
 *
 * 対象画面:
 *   /customers (admin) - plain `<TableHead><SortableHeader/></TableHead>` パターン
 *   /risks (admin) - `SortableResizableHead` パターン (= truncate 包囲、primary bug 経路)
 *
 *   2 パターン両方をカバーしないと、primary bug (SortableResizableHead) または
 *   secondary bug (plain TableHead, table-container overflow-auto による右端クリップ) の
 *   片方を取り逃す。
 *
 * カバレッジ: docs/test/E2E_COVERAGE.md `/customers` `/risks` に sort dropdown 検証として追記
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID } from '../fixtures/run-id';
import { ensureInitialAdmin, cleanupByRunId, disconnectDb } from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';

const ADMIN_EMAIL = `admin-sort-portal-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

let sharedContext: BrowserContext;
let sharedPage: Page;

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:ui:sort-dropdown カラムソート dropdown の可視性 (Portal 化)', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });

    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();

    await sharedPage.goto('/login');
    await sharedPage.getByLabel('組織 ID').fill('default');
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

  test('/customers (plain TableHead パターン) で sortable-header クリック後に menu が visible', async () => {
    const page = sharedPage;
    await page.goto('/customers');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('table')).toBeVisible({ timeout: 10_000 });

    // 「名前」カラムの sortable header をクリック
    const trigger = page
      .locator('[data-testid="sortable-header-button"][data-column-key="name"]')
      .first();
    await expect(trigger).toBeVisible();
    await trigger.click();

    // Portal 経由で document.body 直下に menu が描画される
    const menu = page.locator(
      '[data-testid="sortable-header-menu"][data-column-key="name"]',
    );
    await expect(menu).toBeVisible({ timeout: 2_000 });

    // 昇順 / 降順 menuitem が見える
    await expect(menu.getByRole('menuitem', { name: /↑.*昇順/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /↓.*降順/ })).toBeVisible();

    // Portal 化の証拠: menu の親が <body> 直下にあること (Table 内ではないこと)。
    // = この menu node から最近の祖先 [data-slot="table-container"] は存在しない。
    const isOutsideTable = await menu.evaluate((el) => {
      return el.closest('[data-slot="table-container"]') === null;
    });
    expect(
      isOutsideTable,
      'sortable-header-menu は Portal で table-container の外 (body 直下) にあるべき',
    ).toBe(true);

    // ESC で閉じる動作も合わせて確認 (a11y / 標準操作)
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0, { timeout: 2_000 });
  });

  test('/risks (SortableResizableHead パターン = truncate 包囲経路) で menu が visible', async () => {
    const page = sharedPage;
    await page.goto('/risks');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('table')).toBeVisible({ timeout: 10_000 });

    // 任意の sortable header (= ResizableHead + truncate pr-2 でラップされる本命経路)
    const trigger = page.locator('[data-testid="sortable-header-button"]').first();
    await expect(trigger).toBeVisible();
    await trigger.click();

    const menu = page.locator('[data-testid="sortable-header-menu"]').first();
    await expect(menu).toBeVisible({ timeout: 2_000 });

    // Portal 化の最大の効用: 親 ResizableHead の `truncate pr-2` (overflow:hidden) で
    // クリップされないこと。menu の bounding box が viewport 内に納まっており、
    // 高さが 0 でないこと = visually rendered であることを double-check。
    const box = await menu.boundingBox();
    expect(box, 'menu の bounding box が取得できる').not.toBeNull();
    expect(box!.height).toBeGreaterThan(0);
    expect(box!.width).toBeGreaterThan(0);

    // 後片付け
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0, { timeout: 2_000 });
  });
});
