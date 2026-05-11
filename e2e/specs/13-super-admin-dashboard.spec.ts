/**
 * E2E: super_admin ダッシュボード請求業務正確性テスト (2026-05-11)
 *
 * 役割:
 *   システム管理者ダッシュボード (/admin/super, /admin/super/tenants, /admin/super/usage) が
 *   **請求業務に直結する数値を正確に表示しているか** を E2E で検証する。
 *
 *   このサービスの事業継続性: 請求額の取りこぼし / 過剰請求 はそれぞれ
 *   ・運営者の自腹額増大 (= 取りこぼし)
 *   ・ユーザ離脱 / UX 低下 (= 過剰請求 → 顧客クレーム)
 *   を直接引き起こすため、本 spec は **絶対に通り続ける** ことが事業要件。
 *
 * 検証観点:
 *   1. 認可: admin / general は /admin/super/* にアクセス不可 (redirect or 403)
 *   2. サマリタブ: 顧客テナント A/B が合算され、Default は別セクションに表示される
 *   3. テナント一覧タブ: 顧客テナント A/B が表示され、Default は別行 (請求対象外ラベル)
 *   4. 使用量タブ: 合計課金が LLM + Storage の合算で表示される
 *   5. CSV エクスポート: 顧客テナント A/B が含まれ、Default は含まれない
 *
 * 前提条件:
 *   - 管理テナント (MANAGEMENT_TENANT_ID) は seed で作成済 (= prisma/seed.ts の seedManagementTenantAndSuperAdmin)
 *   - SUPER_ADMIN_INITIAL_* env 変数の有無に関わらず、本 spec は fixture で
 *     管理テナント所属の super_admin user を直接 INSERT して動かす
 *
 * 関連:
 *   - サービス: src/services/super-admin.service.ts
 *   - UI: src/app/(dashboard)/admin/super/**
 *   - API: src/app/api/admin/super/usage/export/route.ts
 *   - KDD: §5.X+23 (集計除外と画面表示の分離)
 */

import {
  test,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { RUN_ID } from '../fixtures/run-id';
import {
  setupSuperAdminFixture,
  cleanupSuperAdminFixture,
  disconnectSuperAdminDb,
  type SuperAdminFixture,
} from '../fixtures/super-admin';

let fixture: SuperAdminFixture | undefined;
let superAdminContext: BrowserContext;
let superAdminPage: Page;
let superAdminRequest: APIRequestContext;

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:super_admin:dashboard システム管理者ダッシュボード請求正確性 (2026-05-11)', () => {
  test.beforeAll(async ({ browser }) => {
    fixture = await setupSuperAdminFixture(RUN_ID);

    // super_admin としてログイン
    superAdminContext = await browser.newContext();
    superAdminPage = await superAdminContext.newPage();
    await superAdminPage.goto('/login');
    await superAdminPage.getByLabel('メールアドレス').fill(fixture.superAdminEmail);
    await superAdminPage.getByLabel('パスワード').fill(fixture.superAdminPassword);
    await superAdminPage.getByRole('button', { name: 'ログイン' }).click();
    await superAdminPage.waitForURL((url) => !url.pathname.includes('/login'), {
      timeout: 10_000,
    });
    superAdminRequest = superAdminContext.request;
  });

  test.afterAll(async () => {
    await superAdminPage?.close().catch(() => undefined);
    await superAdminContext?.close().catch(() => undefined);
    await cleanupSuperAdminFixture(fixture);
    await disconnectSuperAdminDb();
  });

  // ============================================================
  // 1. サマリタブ: 顧客集計 + Default 別セクション
  // ============================================================

  test('サマリタブ: 顧客テナント A/B が合算され、Default テナントが別セクションで表示される', async () => {
    await superAdminPage.goto('/admin/super');
    await superAdminPage.waitForLoadState('networkidle');

    // 「システム管理者ダッシュボード」のヘッダが表示されている
    await expect(
      superAdminPage.getByRole('heading', { name: 'システム管理者ダッシュボード' }),
    ).toBeVisible();

    // 「顧客テナント数」カードに 2 以上 (= A/B が集計に含まれる)
    // 注: 他 spec で作成された顧客テナントが残っている可能性があるため >= 2 で検証
    const customerTenantCountCard = superAdminPage.locator('div', {
      hasText: /^顧客テナント数/,
    }).first();
    await expect(customerTenantCountCard).toContainText(/\d+/);

    // Default テナント (運営者自身) セクションが存在する
    await expect(
      superAdminPage.getByRole('heading', { name: 'Default テナント (運営者自身)' }).first(),
    ).toBeVisible();

    // 「請求対象外」ラベルが表示されている
    await expect(
      superAdminPage.getByText('顧客課金集計には含まれません', { exact: false }).first(),
    ).toBeVisible();

    // 「今月の合計課金 (LLM + Storage)」カードが存在し、内訳行を含む
    await expect(
      superAdminPage.getByText('今月の合計課金 (LLM + Storage)', { exact: false }).first(),
    ).toBeVisible();
    await expect(
      superAdminPage.getByText(/内訳: LLM ¥/).first(),
    ).toBeVisible();
  });

  // ============================================================
  // 2. テナント一覧タブ: 顧客テナント表示 + Default 別行
  // ============================================================

  test('テナント一覧タブ: 顧客テナント A/B が顧客セクションに表示され、Default は別行 (請求対象外ラベル付き)', async () => {
    await superAdminPage.goto('/admin/super/tenants');
    await superAdminPage.waitForLoadState('networkidle');

    // 顧客テナント A/B が一覧に表示される
    await expect(superAdminPage.getByText(fixture!.customerTenantA.name)).toBeVisible();
    await expect(superAdminPage.getByText(fixture!.customerTenantB.name)).toBeVisible();

    // 顧客テナント A の費用 (¥3,000) が表示される
    // (テーブル行内検索: 顧客テナント名を含む行に LLM 費用が表示される)
    const tenantARow = superAdminPage.locator('tr', {
      hasText: fixture!.customerTenantA.name,
    });
    await expect(tenantARow).toContainText('3,000'); // 当月 LLM 費用 ¥3,000

    // Default テナント (運営者自身) セクションが存在する
    await expect(
      superAdminPage.getByRole('heading', { name: 'Default テナント (運営者自身)' }),
    ).toBeVisible();

    // Default テナント行に「請求対象外」ラベルが表示される
    await expect(
      superAdminPage.getByText('(請求対象外)', { exact: false }).first(),
    ).toBeVisible();
  });

  // ============================================================
  // 3. 使用量タブ: 合計課金 + プラン別分布
  // ============================================================

  test('使用量タブ: 合計課金 (LLM + Storage) が併記、プラン別分布が顧客テナントのみ', async () => {
    await superAdminPage.goto('/admin/super/usage');
    await superAdminPage.waitForLoadState('networkidle');

    // 「使用量サマリ (全テナント横断)」ヘッダ
    await expect(
      superAdminPage.getByRole('heading', { name: '使用量サマリ (全テナント横断)' }),
    ).toBeVisible();

    // 「今月の合計課金 (LLM + Storage)」カード + 内訳
    await expect(
      superAdminPage.getByText('今月の合計課金 (LLM + Storage)', { exact: false }).first(),
    ).toBeVisible();

    // Default テナント (運営者自身) セクションが存在
    await expect(
      superAdminPage.getByRole('heading', { name: 'Default テナント (運営者自身)' }).first(),
    ).toBeVisible();

    // プラン別分布: 顧客テナント A=expert, B=pro が含まれる
    // (一覧 capitalize されるので "Expert" / "Pro" として表示)
    const planTable = superAdminPage.locator('table').nth(0); // 最初の table (プラン別分布)
    await expect(planTable).toContainText('expert');
    await expect(planTable).toContainText('pro');
  });

  // ============================================================
  // 4. CSV エクスポート: Default 除外 + 顧客課金正確性
  // ============================================================

  test('CSV エクスポート (当月): 顧客テナント A/B のみ含まれ、Default は除外、Storage が合計に反映', async () => {
    const res = await superAdminRequest.get('/api/admin/super/usage/export');
    expect(res.status()).toBe(200);

    expect(res.headers()['content-type']).toContain('text/csv');
    expect(res.headers()['content-disposition']).toContain('attachment');
    expect(res.headers()['content-disposition']).toMatch(/tenant-usage-\d{4}-\d{2}-current\.csv/);

    const text = await res.text();

    // ヘッダ行に Storage 関連列が含まれる
    expect(text).toContain('Storage月額(円)');
    expect(text).toContain('合計月額(円)');
    expect(text).toContain('請求先メール');

    // 顧客テナント A/B が含まれる
    expect(text).toContain(fixture!.customerTenantA.name);
    expect(text).toContain(fixture!.customerTenantB.name);

    // 顧客テナント A: LLM ¥3000 + Storage(plus) ¥500 = ¥3500
    const lines = text.split('\r\n');
    const lineA = lines.find((l) => l.includes(fixture!.customerTenantA.name));
    expect(lineA, 'tenant-A 行が CSV に存在する').toBeDefined();
    // 列順: ... plan(expert), 呼出数(300), 費用(3000), ユーザ数(1), 予算(空), Storage プラン(plus), 使用量(0), Storage月額(500), 合計月額(3500), ...
    expect(lineA).toContain(',expert,');
    expect(lineA).toContain(',3000,'); // LLM 費用
    expect(lineA).toContain(',plus,'); // Storage プラン
    expect(lineA).toContain(',500,'); // Storage 月額
    expect(lineA).toContain(',3500,'); // 合計

    // 顧客テナント B: LLM ¥30000 + Storage(pro_storage) ¥1500 = ¥31500
    const lineB = lines.find((l) => l.includes(fixture!.customerTenantB.name));
    expect(lineB, 'tenant-B 行が CSV に存在する').toBeDefined();
    expect(lineB).toContain(',pro,');
    expect(lineB).toContain(',30000,');
    expect(lineB).toContain(',pro_storage,');
    expect(lineB).toContain(',1500,');
    expect(lineB).toContain(',31500,');

    // 🚨 重要: Default テナント (= 'default' slug を持つテナント) は CSV に含まれない
    //   (= 請求 CSV に運営者自身のテナントが混入していたら売上計上ミスの原因になる)
    const lineDefault = lines.find((l) => l.includes(',default,'));
    expect(
      lineDefault,
      'CRITICAL: Default テナントが請求 CSV に混入してはならない (請求対象外)',
    ).toBeUndefined();
  });

  // ============================================================
  // 5. 認可: 顧客テナントの admin は /admin/super/* に入れない
  // ============================================================

  test('認可: 顧客テナントの admin は /admin/super/* にアクセスできない (redirect)', async ({
    browser,
  }) => {
    // 顧客テナント A の admin としてログイン
    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await adminPage.goto('/login');
      await adminPage.getByLabel('メールアドレス').fill(fixture!.customerTenantA.adminEmail);
      // fixture と同じパスワード
      await adminPage
        .getByLabel('パスワード')
        .fill(process.env.E2E_SUPER_ADMIN_PASSWORD ?? `E2eSuper!Pw_${RUN_ID}`);
      await adminPage.getByRole('button', { name: 'ログイン' }).click();
      await adminPage.waitForURL((url) => !url.pathname.includes('/login'), {
        timeout: 10_000,
      });

      // /admin/super にアクセスを試行 → / にリダイレクトされる
      await adminPage.goto('/admin/super');
      // layout で redirect('/') されるため、最終 URL が /admin/super で「ない」こと
      await adminPage.waitForLoadState('networkidle');
      const finalUrl = new URL(adminPage.url());
      expect(
        finalUrl.pathname.startsWith('/admin/super'),
        '顧客 admin が /admin/super/* に滞在してはならない (情報漏洩経路)',
      ).toBe(false);

      // CSV エクスポートも 403
      const csvRes = await adminContext.request.get('/api/admin/super/usage/export');
      expect(csvRes.status()).toBe(403);
    } finally {
      await adminContext.close();
    }
  });
});
