/**
 * クローズ済みプロジェクト (status='closed' = 完全な読み取り専用) の write ガード配線 invariant
 * (2026-06-12)。
 *
 * 背景:
 *   `checkPermission` の `STATE_RESTRICTIONS.closed` は write アクションをクローズPJで拒否するが、
 *   一部の write route は「作成者/admin の細粒度判定を service 層に委ねる」目的で **read アクション**
 *   (`risk:read` / `project:read`) を `checkProjectPermission` に渡しており、クローズ制約が効かない
 *   穴があった。これらは `requireProjectNotClosed` でロール判定を変えずクローズのみを弾く。
 *
 * 本テストは「ガードが該当ハンドラに配線されている」ことをソース走査で固定する
 * (ヘルパの振る舞いは api-helpers.test.ts、経路統合は E2E でカバー)。
 * 失敗したら誰かがクローズガードを外した可能性が高い — 即修正すること。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function read(...segs: string[]): string {
  return readFileSync(join(__dirname, ...segs), 'utf8');
}

describe('クローズ済みプロジェクトの write ガード配線 (requireProjectNotClosed)', () => {
  it('リスク/課題 DELETE は requireProjectNotClosed を呼ぶ (risk:read 認可の穴埋め)', () => {
    const src = read('risks', '[riskId]', 'route.ts');
    // import されている
    expect(src).toMatch(/\brequireProjectNotClosed\b/);
    // projectId を渡して呼び出している (DELETE ハンドラ)
    expect(src).toMatch(/requireProjectNotClosed\(\s*projectId/);
  });

  it('振り返り PATCH / DELETE は requireProjectNotClosed を呼ぶ (project:read 認可の穴埋め)', () => {
    const src = read('retrospectives', '[retroId]', 'route.ts');
    const calls = src.match(/requireProjectNotClosed\(\s*projectId/g) ?? [];
    // PATCH と DELETE の 2 ハンドラ分
    expect(calls.length).toBe(2);
  });
});
