/**
 * MemoViewDialog の構造 invariant 回帰テスト (feat/all-list-section-unification, 2026-05-24)。
 *
 * 採用理由:
 *   vitest 設定が `environment: 'node'` のため React render 系テストは別途依存追加が必要。
 *   `sortable-header.test.tsx` 等の source-pattern 先例に倣う。
 *
 * カバーする invariant:
 *   - read-only ダイアログとして fieldset disabled を使う (誤って編集可能化されないこと)
 *   - AttachmentList を canEdit={false} で表示している (添付の参照のみ)
 *   - CommentSection を含む (公開メモへのコメント機能、PR #213)
 *
 * 失敗時の対応:
 *   - fieldset disabled が外れた場合、参照画面で編集が走り PR #165 の設計ルール
 *     「全○○ = 参照のみ」を侵犯する。即座に巻き戻し。
 *   - canEdit={true} になると非作成者でも添付の追加/削除が走り権限破綻。即座に修正。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(join(__dirname, 'memo-view-dialog.tsx'), 'utf8');

describe('MemoViewDialog read-only invariant', () => {
  it('fieldset disabled で全フォームを読み取り専用化している', () => {
    expect(SOURCE).toMatch(/<fieldset\s+disabled\b/);
  });

  it('AttachmentList は canEdit={false} で表示される', () => {
    expect(SOURCE).toMatch(/<AttachmentList[\s\S]*?canEdit=\{false\}/);
  });

  it('CommentSection (PR #213) を含む', () => {
    expect(SOURCE).toMatch(/<CommentSection[\s\S]*?entityType=["']memo["']/);
  });

  it('入力 (Input) には readOnly が指定されている', () => {
    // タイトル / 作成者 / 公開範囲 / 更新日時 などの Input が readOnly であること。
    // 4 つの Input は全て readOnly。
    const readOnlyInputs = SOURCE.match(/<Input[^>]*\breadOnly\b/g) ?? [];
    expect(readOnlyInputs.length).toBeGreaterThanOrEqual(4);
  });
});
