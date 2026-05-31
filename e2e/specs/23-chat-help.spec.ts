/**
 * E2E: チャット意味検索 + たすきフクロウ ヘルプチャット (FAB 一本化パネル)
 * (test/release-acceptance-e2e / 2026-06 / RELEASE_ACCEPTANCE_TEST.md TC-RA-40/41)
 *
 * ★スタブ前提★: 本 spec は embedding/LLM スタブ provider が有効な環境 (CI: EMBEDDING_PROVIDER=stub /
 *   LLM_PROVIDER=stub) でのみ意味を持つ「配線 (wiring) 検証」。スタブが無いと query embedding /
 *   LLM 呼出が鍵なしで fail するため、env 未設定環境では検索結果ゼロ・ヘルプ応答失敗になる。
 *   ※ 実 AI の関連度・回答品質は スタブでは検証できず 👤 人間スモーク (本番) に残る (RELEASE_ACCEPTANCE_TEST.md)。
 *
 * 検証 (配線):
 *   1. FAB (chat-fab) → パネル展開
 *   2. 検索タブ: クエリ送信 → ユーザバブル表示 (= 検索が実行された)
 *   3. ヘルプタブ: 質問送信 → アシスタント回答バブル表示 (= LLM 経路が通った)
 *
 * カバレッジ: docs/test/E2E_COVERAGE.md (/api/chat/search / /api/help/chat / FAB UI)
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { RUN_ID } from '../fixtures/run-id';
import { signupTenantViaUi } from '../fixtures/signup';
import { cleanupTenantByRunId, disconnectDb } from '../fixtures/db';

let context: BrowserContext;
let page: Page;

test.describe.configure({ mode: 'serial', retries: 0 });

test.describe('@feature:chat 意味検索 + ヘルプチャット (FAB 配線)', () => {
  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    // 新規テナント (オンボーディング dismiss 済 = FAB がクリック可能)
    await signupTenantViaUi(page, { label: 'chat', plan: 'beginner' });
  });

  test.afterAll(async () => {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await cleanupTenantByRunId(RUN_ID);
    await disconnectDb();
  });

  test('TC-RA-40: FAB → 検索タブでクエリ送信するとユーザバブルが表示される', async () => {
    await page.getByTestId('chat-fab').click();
    // 既定で検索タブ。検索入力欄 (placeholder で特定) に入力し Enter 送信。
    const searchInput = page.getByPlaceholder('過去の似た案件で発生したリスクは?');
    await expect(searchInput).toBeVisible({ timeout: 10_000 });
    await searchInput.fill('過去の案件で発生したリスクや課題を教えてください');
    await searchInput.press('Enter');
    // 検索が実行された = 送信したクエリのユーザバブルが出る (結果 0 件でも配線は OK)
    await expect(page.getByTestId('chat-user-bubble').first()).toBeVisible({ timeout: 15_000 });
  });

  test('TC-RA-41: ヘルプタブで質問するとアシスタント回答バブルが表示される', async () => {
    await page.getByTestId('chat-panel-tab-help').click();
    const helpInput = page.getByTestId('help-chat-input-textarea');
    await expect(helpInput).toBeVisible({ timeout: 10_000 });
    await helpInput.fill('最初に何をすればいいですか？');
    await page.getByTestId('help-chat-submit').click();
    // LLM スタブが定型回答を返す → アシスタントバブル + 回答本文が出る
    await expect(page.getByTestId('help-chat-assistant-bubble').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('help-chat-answer').first()).toBeVisible();
  });
});
