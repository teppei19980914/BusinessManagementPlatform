/**
 * E2E: バージョン表示 / Changelog / お知らせ / フッタ認証出し分け
 * (初版 feat/app-version-changelog-footer / 2026-05-23,
 *  改 feat/footer-auth-aware-links / 2026-05-31)
 *
 * カバー範囲:
 *   1. `/changelog` (公開) — v1.0.0 エントリと intro 文言が render される
 *   2. `/announcements` (公開) — 一覧と 2026-06-01-launch のリンクが render される
 *   3. `/announcements/[slug]` (公開) — 詳細ページの title / 戻るリンクが render される
 *   4. フッタ (未ログイン) — 共通情報リンクのみ表示、ログイン後限定リンクは出さない
 *   5. フッタ (ログイン後) — 共通情報 + お知らせ / セキュリティ報告 + AccountMenu の
 *      「バージョンアップ情報」(/changelog) が表示される
 *
 * 設計:
 *   - 1-4 は認証不要なので login 経由しない高速 smoke
 *   - 5 は spec 04 と同じ admin 直接ログイン (MFA 無) パターンを最小限で再現
 *   - 視覚回帰は別 layer (e2e/visual/) で対応するため、ここでは機能 smoke のみ
 *
 * 2026-05-31 変更:
 *   旧 `/settings/about` (要認証) テストは削除。ページごと廃止し、運営者 / 規約 / 特商法は
 *   外部 LP に集約 + バージョン/更新履歴は AccountMenu「バージョンアップ情報」へ移設したため。
 *
 * カバレッジ: docs/test/E2E_COVERAGE.md `/changelog` `/announcements` `/announcements/[slug]`
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

  test('未ログイン時のフッタは共通情報のみ表示し、ログイン後限定リンクは出さない', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    const footer = page.getByTestId('app-footer');
    await expect(footer).toBeVisible();
    await expect(footer).toHaveAttribute('data-authenticated', 'false');
    // 共通情報 (製品ページ / 規約 / 特商法) は常時表示
    await expect(footer.getByRole('link', { name: '製品ページ' })).toBeVisible();
    await expect(footer.getByRole('link', { name: '利用規約' })).toBeVisible();
    await expect(footer.getByRole('link', { name: '特定商取引法に基づく表記' })).toBeVisible();
    // ログイン後限定 (お知らせ / セキュリティ報告) は未ログインでは出さない
    await expect(footer.getByTestId('app-footer-announcements')).toHaveCount(0);
    await expect(footer.getByTestId('app-footer-security-report')).toHaveCount(0);
  });
});

test.describe('@feature:settings ログイン後フッタ + バージョンアップ情報', () => {
  test.describe.configure({ mode: 'serial', retries: 0 });

  test.beforeAll(async () => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });
  });

  test.afterAll(async () => {
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  test('ログイン後はフッタにお知らせ/セキュリティ報告 + AccountMenu にバージョンアップ情報が出る', async ({
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

    // フッタはログイン後限定情報を追加表示する
    const footer = page.getByTestId('app-footer');
    await expect(footer).toHaveAttribute('data-authenticated', 'true');
    await expect(footer.getByTestId('app-footer-announcements')).toHaveAttribute(
      'href',
      '/announcements',
    );
    await expect(footer.getByTestId('app-footer-security-report')).toBeVisible();

    // AccountMenu を開き「バージョンアップ情報」が /changelog を指すことを確認。
    // chromium-mobile (iPhone 13 emulation, DPR=3) では auto-hide/sticky ヘッダ配下の
    // hit-test が誤判定し「別要素が intercepts pointer events」で click が timeout する
    // (KDD §5.X+124-126)。定石どおり { force: true } で bypass する。
    await page.getByTestId('account-menu-trigger').click({ force: true });
    await expect(page.getByTestId('account-menu-version-info')).toHaveAttribute(
      'href',
      '/changelog',
    );
  });
});
