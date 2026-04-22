/**
 * 視覚回帰テスト - 設定画面 10 テーマ (PR #96)。
 *
 * 対象: /settings (設定画面) を 10 テーマ全て切り替えて PNG 比較。
 *
 * 背景:
 *   テーマ定義は `src/config/themes.ts` の `THEMES` 定数で 10 種類。
 *   settings 画面で radio クリック → PATCH /api/settings/theme → 画面再レンダ
 *   → `<html data-theme="...">` 属性が切り替わる。各テーマの配色崩れを検知する。
 *
 * ベースライン運用:
 *   `.github/workflows/e2e-visual-baseline.yml` の workflow_dispatch で生成・commit。
 *   初回実行 or テーマトークン変更時は同 workflow を手動トリガ。
 *
 * カバレッジ: 10 PNG (settings-theme-<id>.png) を生成。
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID } from '../fixtures/run-id';
import { ensureInitialAdmin, cleanupByRunId, disconnectDb } from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';

const ADMIN_EMAIL = `admin-themes-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';

// src/config/themes.ts の THEMES と同期。10 テーマ全てを網羅する。
const THEMES: Array<{ id: string; radioLabel: string }> = [
  { id: 'light', radioLabel: 'ライトテーマ(デフォルト)' },
  { id: 'dark', radioLabel: 'ダークテーマ' },
  { id: 'pastel-blue', radioLabel: 'パステル(青)' },
  { id: 'pastel-green', radioLabel: 'パステル(緑)' },
  { id: 'pastel-yellow', radioLabel: 'パステル(黄)' },
  { id: 'pastel-red', radioLabel: 'パステル(赤)' },
  { id: 'pop-blue', radioLabel: 'ポップ(青)' },
  { id: 'pop-green', radioLabel: 'ポップ(緑)' },
  { id: 'pop-yellow', radioLabel: 'ポップ(黄)' },
  { id: 'pop-red', radioLabel: 'ポップ(赤)' },
];

let sharedContext: BrowserContext;
let sharedPage: Page;

test.describe.configure({ mode: 'serial' });

test.describe('@visual:themes 設定画面 10 テーマ マトリクス', () => {
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

  // 各テーマに対して個別 test を生成 (パラメトリック test)
  for (const theme of THEMES) {
    test(`設定画面 テーマ: ${theme.id}`, async () => {
      const page = sharedPage;
      await page.goto('/settings');
      await page.waitForLoadState('networkidle');

      // ラベル文字を UI と Unicode 一致で対応 (全角括弧の罠 LESSONS §4.4)
      // UI 側 (src/config/themes.ts) は全角括弧を使うため、radioLabel を
      // UI に合わせて全角に正規化して検索する
      const uiLabel = theme.radioLabel.replace(/\(/g, '（').replace(/\)/g, '）');

      // テーマ変更 PATCH を明示的に待つ
      const themeRes = page.waitForResponse(
        (r) => r.url().includes('/api/settings/theme') && r.request().method() === 'PATCH',
      );
      await page.getByRole('radio', { name: uiLabel }).click();
      await themeRes;

      // 選択状態 (aria-checked) はクライアント側 state で即時反映されるが、
      // **実際の配色は `<html data-theme="xxx">` 属性で決まる**。これは layout.tsx
      // の Server Component が session から読む値で、router.refresh の RSC 再取得
      // 完了後に初めて書き換わる。
      // LESSONS §4.22: 視覚回帰で動的 state (テーマ等) を captured する前に、
      // **page.reload で data-theme を確定させる**ことが必須。waitForLoadState
      // だけでは router.refresh race で古いテーマの screenshot を取ってしまう。
      await page.reload({ waitUntil: 'networkidle' });

      // <html data-theme="xxx"> が現在のテーマに切替わっていることを確証する
      // (視覚回帰の前提条件、ここで未適用なら screenshot 失敗確実)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id, {
        timeout: 10_000,
      });
      // 念のため選択 radio も checked であること
      await expect(page.getByRole('radio', { name: uiLabel })).toHaveAttribute(
        'aria-checked',
        'true',
      );

      await expect(page).toHaveScreenshot(`settings-theme-${theme.id}.png`, {
        fullPage: true,
      });
    });
  }
});
