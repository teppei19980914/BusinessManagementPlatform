/**
 * E2E: バージョン表示 / Changelog / お知らせ / About (feat/app-version-changelog-footer / 2026-05-23)
 *
 * カバー範囲:
 *   1. `/changelog` (公開) — v1.0.0 エントリと intro 文言が render される
 *   2. `/announcements` (公開) — 一覧と 2026-06-01-launch のリンクが render される
 *   3. `/announcements/[slug]` (公開) — 詳細ページの title / 戻るリンクが render される
 *   4. `/settings/about` (要認証) — サービス情報セクションとバージョン表示
 *
 * 設計:
 *   - 1-3 は認証不要 (PUBLIC_PATHS 追加済) なので login 経由しない高速 smoke
 *   - 4 は spec 04 と同じ admin 直接ログイン (MFA 無) パターンを最小限で再現
 *   - 視覚回帰は別 layer (e2e/visual/) で対応するため、ここでは機能 smoke のみ
 *
 * カバレッジ: docs/test/E2E_COVERAGE.md `/changelog` `/announcements` `/announcements/[slug]` `/settings/about`
 */

import { test, expect } from '@playwright/test';
import { RUN_ID } from '../fixtures/run-id';
import { ensureInitialAdmin, cleanupByRunId, disconnectDb } from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';

const ADMIN_EMAIL = `admin-pr-version-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

test.describe('@feature:public バージョン / お知らせ 公開ページ', () => {
  test('`/changelog` が v1.0.0 エントリと intro 文言を render する', async ({ page }) => {
    await page.goto('/changelog');
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('changelog-page')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: '更新履歴' })).toBeVisible();
    // CHANGELOG.md の最新エントリ (v1.0.0) の見出しが描画される
    await expect(
      page.getByTestId('changelog-entry-1.0.0').getByRole('heading', { name: 'v1.0.0' }),
    ).toBeVisible();
    // feat/app-header-footer-unification (2026-05-24):
    //   全画面共通の AppHeader (testid="app-header-home") に統合済。
    //   旧 testid `public-header-home` は廃止。
    await expect(page.getByTestId('app-header-home')).toBeVisible();
  });

  test('`/announcements` が 2026-06-01-launch エントリのリンクを render する', async ({ page }) => {
    await page.goto('/announcements');
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('announcements-page')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'お知らせ' })).toBeVisible();
    const entry = page.getByTestId('announcement-2026-06-01-launch');
    await expect(entry).toBeVisible();
    // タイトルから詳細ページへの link を持つ
    await expect(entry.getByRole('link', { name: /一般提供を開始しました/ })).toHaveAttribute(
      'href',
      '/announcements/2026-06-01-launch',
    );
  });

  test('`/announcements/[slug]` 詳細ページが title と「一覧に戻る」リンクを持つ', async ({
    page,
  }) => {
    await page.goto('/announcements/2026-06-01-launch');
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('announcement-detail-2026-06-01-launch')).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole('heading', { name: /一般提供を開始しました/ }),
    ).toBeVisible();
    // 一覧へ戻るリンク
    await expect(page.getByRole('link', { name: /一覧に戻る/ })).toHaveAttribute(
      'href',
      '/announcements',
    );
  });
});

test.describe('@feature:settings /settings/about 認証必須', () => {
  test.describe.configure({ mode: 'serial', retries: 0 });

  test.beforeAll(async () => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });
  });

  test.afterAll(async () => {
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('admin login 後に /settings/about が render され、バージョン + 運営者名が表示される', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.goto('/login');
    await page.getByLabel('組織 ID').fill('default');
    await page.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await page.getByLabel('パスワード').fill(ADMIN_PW);
    await page.getByRole('button', { name: 'ログイン', exact: true }).click();
    await waitForProjectsReady(page);

    await page.goto('/settings/about');
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('about-page')).toBeVisible({ timeout: 10_000 });
    // バージョン表示は "v1.0.0" 形式
    await expect(page.getByTestId('about-version')).toHaveText(/^v\d+\.\d+\.\d+/);
    // 運営者名は src/config/operator.ts の OPERATOR_NAME = '須山 哲平'
    await expect(page.getByTestId('about-operator-name')).toHaveText('須山 哲平');
    // /changelog への遷移リンク
    await expect(page.getByTestId('about-changelog-link')).toHaveAttribute('href', '/changelog');
  });
});
