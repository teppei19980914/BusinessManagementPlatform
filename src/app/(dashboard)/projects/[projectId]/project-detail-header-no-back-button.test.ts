/**
 * プロジェクト詳細ヘッダー「一覧に戻る」ボタン廃止の invariant (2026-06-09)。
 *
 * 仕様:
 *   プロジェクト詳細画面の右上ヘッダーから「一覧に戻る」ボタンを廃止した。
 *   一覧へはヘッダーの「たすきば」ロゴ / 「全プロジェクト」タブ (どちらも
 *   PROJECTS_ROUTE) で戻れるため、専用の戻るボタンは冗長。
 *
 * 本テストは「ボタンが復活していないこと」をソース走査 + i18n カタログ走査で固定する。
 * 失敗したら誰かが backToList ボタン / キーを復活させた可能性が高い — 意図を確認すること。
 *
 * 関連: COLUMN_USAGE_MAP.md (概要タブ ヘッダーレイアウト) / field-reference.md
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import jaMessages from '@/i18n/messages/ja.json';
import enMessages from '@/i18n/messages/en-US.json';

describe('プロジェクト詳細ヘッダー: 一覧に戻るボタン廃止 invariant', () => {
  it('project-detail-client は backToList ボタンを描画しない', () => {
    const src = readFileSync(join(__dirname, 'project-detail-client.tsx'), 'utf8');
    // ボタンの翻訳キー使用と、その onClick ハンドラ (router.push('/projects')) が
    // ヘッダーから消えていること。削除フローの router.push('/projects') (L450 相当) は
    // onClick の即時呼び出し形ではなく handleConfirmDelete 内なので誤検知しない。
    expect(src).not.toMatch(/t\('backToList'\)/);
    expect(src).not.toMatch(/onClick=\{\(\) => router\.push\('\/projects'\)\}/);
  });

  it('project 名前空間に backToList キーが存在しない (ja / en)', () => {
    const ja = jaMessages as { project?: Record<string, string> };
    const en = enMessages as { project?: Record<string, string> };
    expect(ja.project && 'backToList' in ja.project).toBe(false);
    expect(en.project && 'backToList' in en.project).toBe(false);
  });

  it('お知らせ画面 (announcementsPage) の backToList は維持されている', () => {
    // 別名前空間の同名キーは announcements/[slug] で使用中のため巻き込み削除しない。
    const ja = jaMessages as { announcementsPage?: Record<string, string> };
    const en = enMessages as { announcementsPage?: Record<string, string> };
    expect(ja.announcementsPage?.backToList).toBeTruthy();
    expect(en.announcementsPage?.backToList).toBeTruthy();
  });
});
