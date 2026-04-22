/**
 * E2E 実行ごとに一意な prefix を生成する (PR #90)。
 *
 * 目的: テスト中に作成された全データ (admin アカウント / プロジェクト名 / メンバー氏名 等)
 *       に共通 prefix を付け、最終クリーンアップで prefix 一致一括削除を可能にする。
 *       テストが途中クラッシュしても Postgres コンテナ破棄で物理的に消えるが、
 *       ローカル実行時の残存防止として機能する。
 *
 * 形式: `e2e-<ISO日時>-<pid>-<random>` (人間可読 + 衝突しない長さ)
 *
 * 使い方:
 *   import { RUN_ID, withRunId } from '@/e2e/fixtures/run-id';
 *   const email = withRunId('admin') + '@example.com';
 *   // → e2e-20260422T093015-1234-a1b2-admin@example.com
 */

import { randomBytes } from 'crypto';

const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15);
const pid = process.pid;
const rand = randomBytes(2).toString('hex');

export const RUN_ID = `e2e-${timestamp}-${pid}-${rand}`;

/** 実行 ID を suffix にして一意な文字列を生成する。 */
export function withRunId(label: string): string {
  return `${RUN_ID}-${label}`;
}

/** 実行 ID を識別するための正規表現 (クリーンアップ用途)。 */
export const RUN_ID_PATTERN = /^e2e-\d{8}T?\d{6}-\d+-[a-f0-9]{4}/;
