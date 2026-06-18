/**
 * Playwright 設定 — Post-Deploy Production Smoke 専用
 *
 * 通常の playwright.config.ts (CI エフェメラル DB + stub providers) とは独立した設定。
 * e2e/smoke/ 配下のスペックのみ実行し、SMOKE_BASE_URL で指定した実デプロイ済み URL を叩く。
 *
 * 呼び出し方:
 *   pnpm playwright test --config=playwright.config.smoke.ts
 *
 * 必須 GitHub Secrets / 環境変数:
 *   SMOKE_BASE_URL       : 本番 URL (例: https://tasukiba.com)
 *   SMOKE_TENANT_SLUG    : スモークテスト用テナントの組織 ID
 *   SMOKE_ADMIN_EMAIL    : スモークテスト用アカウントのメールアドレス (MFA 無効であること)
 *   SMOKE_ADMIN_PASSWORD : スモークテスト用アカウントのパスワード
 *
 * トリガー:
 *   main push 後、post-deploy-smoke.yml が 5 分待機してから自動実行する。
 *   Netlify Webhook は不要 (HTTP POST request はカスタム認証ヘッダーを設定できないため使用不可)。
 *
 * 関連:
 *   - e2e/smoke/production-smoke.spec.ts : スモーク本体
 *   - .github/workflows/post-deploy-smoke.yml : CI ワークフロー
 *   - docs/test/RELEASE_ACCEPTANCE_TEST.md : go/no-go 判定基準
 */

import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'https://tasukiba.com';

export default defineConfig({
  testDir: './e2e/smoke',
  fullyParallel: false,
  forbidOnly: true,
  retries: 1,
  workers: 1,
  timeout: 60_000,
  reporter: [
    ['html', { open: 'never', outputFolder: 'playwright-report-smoke' }],
    ['list'],
    ['github'],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'on',
    screenshot: 'on',
    video: 'on',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  // webServer は不要: 実デプロイ済み URL を直接参照する
});
