/**
 * 視覚回帰テスト - ダッシュボード主要画面 (PR #95 雛形 → PR #96 有効化 → PR #96 hotfix で改修)。
 *
 * 対象: /settings / /projects/[id] 概要タブ (admin light テーマ)
 *
 * 設計判断 (PR #96 hotfix):
 *   - /projects 一覧の視覚回帰は **並列テスト環境で他 spec のデータが DB に残り**
 *     baseline 時と行数が一致しないため、mask 境界が一致せず常に fail する。
 *     → 削除。10 テーマ マトリクス (settings-themes) に主視覚回帰を集約。
 *   - /projects/[id] 概要タブは表示データが projectId 単独に絞られるが、
 *     plannedStartDate / plannedEndDate が **日付ドリフト** で毎日 pixel diff を
 *     起こす。→ 固定日付 (2026-01-01 / 2026-02-01) で作成し安定化。
 *   - プロジェクト名 (RUN_ID 依存) は mask で除外する。
 *
 * ベースライン運用:
 *   - baseline PNG は `.github/workflows/e2e-visual-baseline.yml` で生成・自動 commit
 *   - UI 変更時は `[gen-visual]` commit で再生成
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID, withRunId } from '../fixtures/run-id';
import { ensureInitialAdmin, cleanupByRunId, disconnectDb } from '../fixtures/db';
import { waitForProjectsReady } from '../fixtures/auth';
import { createProjectViaApi } from '../fixtures/project';

const ADMIN_EMAIL = `admin-visual-${RUN_ID}@example.com`.toLowerCase();
const ADMIN_PW = 'E2eAdmin!Pw_2026';
const PROJECT_NAME = withRunId('VisualProject');

// 視覚回帰では日付ドリフトを防ぐため固定日付を使う (PR #96 hotfix)
const FIXED_START_DATE = '2026-01-01';
const FIXED_END_DATE = '2026-02-01';

let sharedContext: BrowserContext;
let sharedPage: Page;
let projectId = '';

test.describe.configure({ mode: 'serial' });

test.describe('@visual:dashboard ダッシュボード主要画面', () => {
  test.beforeAll(async ({ browser }) => {
    await ensureInitialAdmin(ADMIN_EMAIL, ADMIN_PW, { forcePasswordChange: false });

    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();

    await sharedPage.goto('/login');
    // ADR-0016 (2026-05-20): 組織 ID 必須化
    await sharedPage.getByLabel('組織 ID').fill('default');
    await sharedPage.getByLabel('メールアドレス').fill(ADMIN_EMAIL);
    await sharedPage.getByLabel('パスワード').fill(ADMIN_PW);
    await sharedPage.getByRole('button', { name: 'ログイン' }).click();
    await waitForProjectsReady(sharedPage);

    const { id } = await createProjectViaApi(sharedPage, {
      name: PROJECT_NAME,
      plannedStartDate: FIXED_START_DATE,
      plannedEndDate: FIXED_END_DATE,
    });
    projectId = id;
  });

  test.afterAll(async () => {
    await sharedPage.close();
    await sharedContext.close();
    await cleanupByRunId(RUN_ID);
    await disconnectDb();
  });

  // 「プロジェクト一覧」の視覚回帰は削除 (PR #96 hotfix)。
  // 理由: 並列テスト環境で他 spec のデータが DB に残留し、baseline 生成時と
  // テスト実行時で一覧の行数が異なる。mask は動的に tbody tr を選ぶため、
  // マスク境界が baseline と一致せず、常に pixel diff で fail する。
  // 主要視覚回帰は settings-themes.spec.ts (10 テーマ マトリクス) でカバーする。

  test('設定画面 初期表示 (light テーマ)', async () => {
    const page = sharedPage;
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot('settings-light.png', { fullPage: true });
  });

  test('プロジェクト詳細 概要タブ 初期表示 (light テーマ)', async ({}, testInfo) => {
    // PR fix/visual-mobile-drift (2026-05-11): 7 回目の確率的 drift を断ち切るため
    //   chromium-mobile project から本 spec を除外する。
    //
    //   背景: E2E_LESSONS §4.43 / §4.53 #14 に詳述の通り、chromium-mobile での
    //   `project-detail-light.png` baseline width が 414 ↔ 413 で **真の確率的 oscillation**
    //   を起こす (6 回 [gen-visual] でリセットしても 1 日後に再発)。
    //   `git log <baseline-png>` で baseline 自身が 414→413→414→413→414→413→414 と
    //   交互に書き換わっている事実が確認済み (PR fix/visual-mobile-drift の調査ログ)。
    //
    //   根本原因: chromium-mobile (iPhone 13 viewport / DPR>1) での Playwright snapshot 取得時、
    //   body content width 計測が再生成ごとに 1px ずれる Playwright/Chromium 内部の確率的挙動。
    //
    //   対処方針: chromium project で同じ assertion が安定稼働しているため、本 spec を
    //   chromium-mobile から除外しても回帰検知力は維持される。mobile レイアウト固有の
    //   regression は `settings-themes.spec.ts` (10 テーマ マトリクス) で別途カバー。
    test.skip(
      testInfo.project.name === 'chromium-mobile',
      'baseline width が 414↔413 で確率的振動するため chromium-mobile では skip (E2E_LESSONS §4.43)',
    );
    const page = sharedPage;
    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');
    // 見出し (RUN_ID 含むプロジェクト名) を mask。構造ベースの比較にする
    await expect(page).toHaveScreenshot('project-detail-light.png', {
      fullPage: true,
      mask: [page.locator('h2').first()],
    });
  });
});
