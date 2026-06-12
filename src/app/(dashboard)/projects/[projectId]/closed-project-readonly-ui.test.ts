/**
 * クローズ済みプロジェクト (status='closed' = 読み取り専用) の UI ガード配線 invariant
 * (2026-06-12)。
 *
 * 仕様:
 *   - クローズ済みPJでは各資産 (リスク/課題・ナレッジ・振り返り・WBS・ステークホルダー) の
 *     作成・編集・削除 UI を非表示にする (サーバ側 STATE_RESTRICTIONS.closed と二重防御)。
 *   - 行クリックで開く編集ダイアログは強制 readOnly (保存ボタン・入力欄を無効化)。
 *   - コメント投稿欄も非表示にする (readOnly は「非所有者の閲覧=コメント可」も含むため、
 *     コメント遮断は closedProject フラグで別判定)。
 *
 * 本テストは配線をソース走査で固定する (描画挙動は E2E、API は各 service/route テストでカバー)。
 * 失敗したら誰かがクローズガードを外した可能性が高い — 即修正すること。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function read(...segs: string[]): string {
  return readFileSync(join(__dirname, ...segs), 'utf8');
}

function dialog(name: string): string {
  return readFileSync(join(__dirname, '..', '..', '..', '..', 'components', 'dialogs', name), 'utf8');
}

describe('クローズ済みプロジェクトの読み取り専用 UI 配線', () => {
  it('project-detail-client は 4 つの CRUD 一覧 client に isReadOnly={isReadOnlyByStatus} を渡す', () => {
    const src = read('project-detail-client.tsx');
    const passes = src.match(/isReadOnly=\{isReadOnlyByStatus\}/g) ?? [];
    // リスク + 課題 (RisksClient x2) + 振り返り + ナレッジ = 4 箇所
    expect(passes.length).toBeGreaterThanOrEqual(4);
  });

  const CLIENTS: Array<{ name: string; file: string }> = [
    { name: 'ナレッジ', file: join('knowledge', 'project-knowledge-client.tsx') },
    { name: 'リスク/課題', file: join('risks', 'risks-client.tsx') },
    { name: '振り返り', file: join('retrospectives', 'retrospectives-client.tsx') },
  ];

  describe.each(CLIENTS)('$name 一覧 client', ({ file }) => {
    const src = read(file);

    it('isReadOnly prop を受け取る', () => {
      expect(src).toMatch(/isReadOnly\??:\s*boolean/);
    });

    it('編集ダイアログ readOnly に isReadOnly を OR 合成している', () => {
      // readOnly={ isReadOnly || ( ... ) } の形
      expect(src).toMatch(/readOnly=\{\s*isReadOnly\s*\|\|/);
    });

    it('編集ダイアログへ closedProject={isReadOnly} を渡している', () => {
      expect(src).toMatch(/closedProject=\{isReadOnly\}/);
    });
  });

  it('ステークホルダー client は削除ボタンを isReadOnly でガードし、編集ダイアログに readOnly/closedProject を渡す', () => {
    const src = read('stakeholders', 'stakeholders-client.tsx');
    expect(src).toMatch(/\{!isReadOnly\s*&&/); // 削除ボタン等の非表示
    expect(src).toMatch(/readOnly=\{isReadOnly\}/);
    expect(src).toMatch(/closedProject=\{isReadOnly\}/);
  });

  const DIALOGS = [
    'knowledge-edit-dialog.tsx',
    'risk-edit-dialog.tsx',
    'retrospective-edit-dialog.tsx',
    'stakeholder-edit-dialog.tsx',
  ];

  describe.each(DIALOGS)('編集ダイアログ %s', (name) => {
    const src = dialog(name);

    it('closedProject prop を受け取る', () => {
      expect(src).toMatch(/closedProject\??:\s*boolean/);
    });

    it('CommentSection に mutationsLocked={closedProject} を渡しクローズ時は投稿・編集・削除を不可にする', () => {
      expect(src).toMatch(/mutationsLocked=\{closedProject\}/);
    });
  });
});
