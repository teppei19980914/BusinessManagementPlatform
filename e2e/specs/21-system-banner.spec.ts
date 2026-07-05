/**
 * E2E: システム周知バナー (画面上部の帯メッセージ / ADR-0036)
 *
 * 検証観点:
 *   1. super_admin が API で作成したバナーが、ログイン後の全ダッシュボード画面の上部に表示される
 *   2. 緊急度に応じた色 (data-severity) が反映される
 *   3. ×で閉じると当該セッションでは非表示になり、リロードしても出ない
 *   4. 別セッション (新規コンテキストで再ログイン) では再表示される
 *   5. 表示期間が重なるバナーの作成は 409 OVERLAP で弾かれる (1 本制約)
 *   6. 管理画面 (/admin/super/banners) の一覧に作成したバナーが出る
 *   7. バナー内リンクが WCAG AA コントラスト基準 (4.5:1) を満たす
 *      (axe-core / high/medium/low 全緊急度 — デグレ検出: MarkdownDisplay 切り替えで
 *       [&_a]:text-current が外れると blue-on-blue 等で即座に違反となる)
 *
 * バナーは **グローバル** (全テナント共通) のため、super_admin 自身もログインユーザとして
 * 帯を閲覧できる。本 spec は super_admin の fixture のみで閲覧側・管理側の双方を検証する。
 *
 * 関連:
 *   - サービス: src/services/system-banner.service.ts
 *   - API: src/app/api/admin/super/banners/**
 *   - UI: src/components/system-banner-bar.tsx / src/app/(dashboard)/admin/super/banners/**
 */

import {
  test,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type Browser,
} from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { RUN_ID } from '../fixtures/run-id';
import {
  setupSuperAdminFixture,
  cleanupSuperAdminFixture,
  disconnectSuperAdminDb,
  type SuperAdminFixture,
} from '../fixtures/super-admin';
import { waitForProjectsReady } from '../fixtures/auth';

let fixture: SuperAdminFixture | undefined;
let superAdminContext: BrowserContext;
let superAdminPage: Page;
let superAdminRequest: APIRequestContext;
const createdBannerIds: string[] = [];

test.describe.configure({ mode: 'serial', retries: 0 });

async function loginSuperAdmin(browser: Browser, fx: SuperAdminFixture): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('組織 ID').fill('platform-admin');
  await page.getByLabel('メールアドレス').fill(fx.superAdminEmail);
  await page.getByLabel('パスワード').fill(fx.superAdminPassword);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await waitForProjectsReady(page);
  return { context, page };
}

test.describe('@feature:super_admin:banners システム周知バナー (ADR-0036)', () => {
  test.beforeAll(async ({ browser }) => {
    fixture = await setupSuperAdminFixture(RUN_ID);
    const s = await loginSuperAdmin(browser, fixture);
    superAdminContext = s.context;
    superAdminPage = s.page;
    superAdminRequest = superAdminContext.request;
  });

  test.afterAll(async () => {
    // 作成したバナーを API で物理削除 (グローバルなので他 spec へ影響させない)
    for (const id of createdBannerIds) {
      await superAdminRequest?.delete(`/api/admin/super/banners/${id}`).catch(() => undefined);
    }
    await superAdminPage?.close().catch(() => undefined);
    await superAdminContext?.close().catch(() => undefined);
    await cleanupSuperAdminFixture(fixture);
    await disconnectSuperAdminDb();
  });

  const MESSAGE = `E2E メンテナンス告知 ${RUN_ID}`;

  test('super_admin がバナーを作成でき、ログイン後の画面上部に色付きで表示される', async () => {
    const now = Date.now();
    const res = await superAdminRequest.post('/api/admin/super/banners', {
      data: {
        message: MESSAGE,
        severity: 'high',
        startAt: new Date(now - 60 * 60 * 1000).toISOString(),
        endAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
        enabled: true,
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBeTruthy();
    createdBannerIds.push(body.data.id);

    await superAdminPage.goto('/projects');
    await waitForProjectsReady(superAdminPage);
    const banner = superAdminPage.getByTestId('system-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(MESSAGE);
    await expect(banner).toHaveAttribute('data-severity', 'high');
  });

  test('期間が重なる 2 本目の作成は 409 OVERLAP で弾かれる (1 本制約)', async () => {
    const now = Date.now();
    const res = await superAdminRequest.post('/api/admin/super/banners', {
      data: {
        message: `重複バナー ${RUN_ID}`,
        severity: 'low',
        startAt: new Date(now).toISOString(),
        endAt: new Date(now + 60 * 60 * 1000).toISOString(),
        enabled: true,
      },
    });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('OVERLAP');
  });

  test('×で閉じると当該セッションでは非表示になり、リロードしても出ない', async () => {
    await superAdminPage.goto('/projects');
    await waitForProjectsReady(superAdminPage);
    const banner = superAdminPage.getByTestId('system-banner');
    await expect(banner).toBeVisible();

    await banner.getByRole('button', { name: 'このお知らせを閉じる' }).click();
    await expect(banner).toBeHidden();

    // 同一セッションでリロード → 破棄状態は維持され再表示されない
    await superAdminPage.reload();
    await waitForProjectsReady(superAdminPage);
    await expect(superAdminPage.getByTestId('system-banner')).toBeHidden();
  });

  test('別セッション (新規ログイン) では帯が再表示される', async ({ browser }) => {
    const fresh = await loginSuperAdmin(browser, fixture!);
    try {
      await fresh.page.goto('/projects');
      await waitForProjectsReady(fresh.page);
      await expect(fresh.page.getByTestId('system-banner')).toBeVisible();
      await expect(fresh.page.getByTestId('system-banner')).toContainText(MESSAGE);
    } finally {
      await fresh.page.close().catch(() => undefined);
      await fresh.context.close().catch(() => undefined);
    }
  });

  test('管理画面の一覧に作成したバナーが「表示中」で出る', async () => {
    await superAdminPage.goto('/admin/super/banners');
    await superAdminPage.waitForLoadState('networkidle');
    const row = superAdminPage.locator('tr', { hasText: MESSAGE });
    await expect(row).toBeVisible();
    await expect(row).toContainText('表示中');
  });

  test('バナー内リンクのカラーコントラストが WCAG AA を満たす (high/medium/low 全緊急度)', async ({ browser }) => {
    // 3 severity × (新規コンテキスト作成 + ログイン + axe 解析) で 30s を超えるため延長
    test.setTimeout(90_000);
    // URL を含むメッセージで <a> 要素を描画させ、バナー背景とのコントラスト比を
    // axe-core が WCAG AA (4.5:1) 基準で自動判定する。
    // MarkdownDisplay 内の <a> は text-info で固定されているため、親側の
    // [&_a]:text-current override が外れると blue-on-blue 等で即座に違反となる。
    const URL_MESSAGE = `axe テスト ${RUN_ID} https://example.com`;
    const now = Date.now();
    const highBannerId = createdBannerIds[0];

    for (const [i, severity] of (['high', 'medium', 'low'] as const).entries()) {
      if (i === 0) {
        // 既存の high バナーのメッセージを URL 入りに更新して再利用
        await superAdminRequest.patch(`/api/admin/super/banners/${highBannerId}`, {
          data: { message: URL_MESSAGE, enabled: true },
        });
      } else {
        // 前の severity を取り下げてから新規作成 (1 本制約)
        const prevId = i === 1 ? highBannerId : createdBannerIds[createdBannerIds.length - 1];
        await superAdminRequest.patch(`/api/admin/super/banners/${prevId}`, {
          data: { enabled: false },
        });
        const res = await superAdminRequest.post('/api/admin/super/banners', {
          data: {
            message: URL_MESSAGE,
            severity,
            startAt: new Date(now - 60 * 60 * 1000).toISOString(),
            endAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
            enabled: true,
          },
        });
        expect(res.status()).toBe(201);
        const body = await res.json();
        createdBannerIds.push(body.data.id);
      }

      // sessionStorage のバナー破棄状態をリセットするため、新規コンテキストでログイン
      const fresh = await loginSuperAdmin(browser, fixture!);
      try {
        await fresh.page.goto('/projects');
        await waitForProjectsReady(fresh.page);
        const banner = fresh.page.getByTestId('system-banner');
        await expect(banner).toBeVisible();
        await expect(banner).toHaveAttribute('data-severity', severity);

        // axe-core: バナー要素スコープで color-contrast ルールのみ検査
        const results = await new AxeBuilder({ page: fresh.page })
          .include('[data-testid="system-banner"]')
          .withRules(['color-contrast'])
          .analyze();
        expect(
          results.violations,
          `severity="${severity}" で WCAG AA コントラスト違反を検出:\n${JSON.stringify(results.violations, null, 2)}`
        ).toHaveLength(0);
      } finally {
        await fresh.page.close().catch(() => undefined);
        await fresh.context.close().catch(() => undefined);
      }
    }
  });
});
