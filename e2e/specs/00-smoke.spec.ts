/**
 * E2E スモークテスト (PR #90 基盤)。
 *
 * 目的:
 *   CI 環境構築とブラウザ起動の疎通確認のみ。本番ロジックには踏み込まない。
 *   具体シナリオ (Steps 1-12) は後続 PR (B〜E) で追加する。
 *
 * カバレッジ記録: docs/E2E_COVERAGE.md の「ログイン画面」行にマッピング
 */

import { test, expect } from '@playwright/test';

test.describe('@feature:auth:login スモーク', () => {
  test('ログイン画面が表示される', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'たすきば' })).toBeVisible();
    await expect(page.getByLabel('メールアドレス')).toBeVisible();
    await expect(page.getByLabel('パスワード')).toBeVisible();
  });

  test('不正なメールアドレスでログイン失敗 (enumeration 対策: 一般エラー文言)', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('メールアドレス').fill('nobody@example.com');
    await page.getByLabel('パスワード').fill('wrong-password');
    await page.getByRole('button', { name: 'ログイン' }).click();
    await expect(
      page.getByText('メールアドレスまたはパスワードが正しくありません'),
    ).toBeVisible();
  });
});
