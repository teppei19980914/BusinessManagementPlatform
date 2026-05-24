/**
 * AdminMemoDeleteButton の invariant 回帰テスト (feat/all-list-section-unification, 2026-05-24)。
 *
 * カバーする invariant:
 *   - confirm() で削除前にユーザ確認を取る (誤クリック保護)
 *   - DELETE /api/memos/{memoId} を呼ぶ (POST/PUT で呼ぶ実装ミスを防ぐ)
 *   - withLoading でラップしロード中の重複クリックを防ぐ
 *
 * 採用理由:
 *   vitest 設定 environment:'node' のため source-pattern 先例に倣う。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(join(__dirname, 'admin-delete-button.tsx'), 'utf8');

describe('AdminMemoDeleteButton invariant', () => {
  it('confirm() で削除前にユーザ確認を取る', () => {
    expect(SOURCE).toMatch(/if\s*\(!confirm\(/);
  });

  it('DELETE /api/memos/{memoId} を呼ぶ', () => {
    expect(SOURCE).toMatch(/fetch\(\s*`\/api\/memos\/\$\{memoId\}`/);
    expect(SOURCE).toMatch(/method:\s*['"]DELETE['"]/);
  });

  it('withLoading でラップしている (重複クリック防止)', () => {
    expect(SOURCE).toMatch(/withLoading\(/);
  });

  it('成功/失敗 toast を表示する', () => {
    expect(SOURCE).toMatch(/showSuccess\(/);
    expect(SOURCE).toMatch(/showError\(/);
  });
});
