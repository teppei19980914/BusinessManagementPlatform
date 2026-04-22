/**
 * 手動チェックポイント用スクリーンショット (PR #93 hotfix 2)
 *
 * 役割:
 *   シナリオの節目でラベル付きスクリーンショットを残し、CI レポートダウンロード後の
 *   目視確認を容易にする。Playwright 標準の trace/screenshot/video とは独立した
 *   「意味のある瞬間」をキャプチャする。
 *
 * 出力先:
 *   `test-results/steps/` に `<ISO日時>-<ラベル>.png` として保存。
 *   e2e.yml の Artifact アップロード対象 (test-results/ 配下) に自動的に含まれる。
 *
 * 使い方:
 *   await snapshotStep(page, 'step-1-after-login');
 *   await snapshotStep(page, 'mfa-qr-visible');
 */

import { mkdirSync } from 'fs';
import { join } from 'path';
import type { Page } from '@playwright/test';

const BASE_DIR = join(process.cwd(), 'test-results', 'steps');
mkdirSync(BASE_DIR, { recursive: true });

export async function snapshotStep(page: Page, label: string): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = join(BASE_DIR, `${timestamp}-${safeLabel}.png`);
  await page.screenshot({ path: file, fullPage: true });
}
