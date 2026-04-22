/**
 * Playwright 設定 (PR #90 基盤 / 段階的導入):
 *
 * 方針:
 *   - CI では Next.js を事前にビルド + start で起動し、Playwright は localhost:3000 を叩く
 *   - ローカル開発者は `pnpm dev` を起動した状態で `pnpm test:e2e` を実行する
 *   - Postgres は CI で GitHub Actions の services: postgres で新規コンテナ起動、
 *     ジョブ終了で破棄されるエフェメラル。ローカルは各開発者の Supabase ローカルに接続。
 *   - 視覚回帰は built-in `toHaveScreenshot()` を使用、ベースライン PNG は
 *     e2e/**__screenshots__/ にコミット。PR レビュー中に更新を許容する方針。
 *
 * 並列戦略:
 *   - specs/ 配下の機能シナリオは describe.serial で強制順序
 *   - visual/ 配下は並列実行可 (独立スクショ)
 *
 * 関連:
 *   - docs/E2E_COVERAGE.md: カバレッジ一覧 (CI で gap 検出)
 *   - .github/workflows/e2e.yml: CI 設定
 *   - docs/DEVELOPER_GUIDE.md §11: E2E 追加手順
 */

import { defineConfig, devices } from '@playwright/test';
import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PORT = process.env.PORT || '3000';
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${PORT}`;
const isCI = !!process.env.CI;

// PR #92: E2E 招待メール捕捉のため inbox provider のディレクトリを用意する。
// Playwright 側プロセスと Next.js サーバ側プロセスの双方がアクセスする。
const INBOX_DIR = process.env.INBOX_DIR || join(tmpdir(), 'tasukiba-e2e-inbox');
mkdirSync(INBOX_DIR, { recursive: true });
// Playwright テスト本体が参照できるようにエクスポート (spawn 前に process.env へ反映)。
process.env.INBOX_DIR = INBOX_DIR;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // serial describe を尊重するため default false
  forbidOnly: isCI, // CI で test.only() を禁止
  retries: isCI ? 2 : 0, // flaky 対策。CI では 2 回まで retry
  workers: isCI ? 2 : 1, // CI リソース節約、ローカルは 1 worker で順序安定
  reporter: [
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['list'],
    ['github'],
  ],
  use: {
    baseURL,
    // PR #93 hotfix 2: 人間が E2E の挙動を目視確認できるよう、成否を問わず常時記録する。
    // trace は Playwright 最強の可視化ツール (全 action + 各ステップの screenshot +
    // DOM/network/console タイムライン)。video とステップ後の screenshot も併記して
    // 「CI レポートをダウンロード → 開く → 動画や trace を見る」だけで test 内容が理解できる状態を目指す。
    trace: 'on',
    screenshot: 'on',
    video: 'on',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  // 視覚回帰の閾値: OS / フォントレンダリング差を許容しつつ、意図的変更は検出
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01, // 1% まで許容
      threshold: 0.2,           // pixel 比較の感度
    },
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
  webServer: isCI
    ? {
        // CI: build 済みの Next.js standalone サーバを起動。
        // next.config.ts で `output: 'standalone'` を指定しているため `pnpm start`
        // (= `next start`) は使えず、必ず `.next/standalone/server.js` を node で起動する。
        // 静的アセット (public/ と .next/static/) は e2e.yml の別ステップで
        // .next/standalone/ 配下にコピー済。
        command: 'node .next/standalone/server.js',
        url: baseURL,
        timeout: 120_000,
        reuseExistingServer: false,
        env: {
          NODE_ENV: 'production',
          PORT,
          HOSTNAME: '0.0.0.0',
          DATABASE_URL: process.env.DATABASE_URL || '',
          DIRECT_URL: process.env.DIRECT_URL || '',
          NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET || '',
          // PR #92: 招待メール等の外部送信を避けつつ、テストから中身を検証するため
          // inbox プロバイダを使用。INBOX_DIR 配下に 1 通 1 JSON で書き出される。
          MAIL_PROVIDER: 'inbox',
          INBOX_DIR,
        },
      }
    : undefined, // ローカルは開発者が pnpm dev を別途起動
});
