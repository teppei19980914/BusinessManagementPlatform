/**
 * HelpClient のソースパターン回帰テスト (feat/mascot-owl 2026-05-27)。
 *
 * vitest 設定 environment='node' のため、AppHeader と同じく source-pattern (ファイル内容を
 * 文字列として読み込んで matcher を当てる) でユーザに見せる要素の存在 invariant を担保する。
 * help-client.tsx は React レンダリングを伴うため、機能テストは Playwright (e2e) に委ねる。
 *
 * 担保対象:
 *   - 「サービスについて」FAQ カテゴリ存在
 *   - マスコット FAQ 質問文・たすきフクロウの紹介・public/mascot-owl.png の参照
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT_FILE = join(__dirname, 'help-client.tsx');
const source = readFileSync(CLIENT_FILE, 'utf8');

describe('HelpClient のマスコット FAQ invariant (feat/mascot-owl 2026-05-27)', () => {
  it('「サービスについて」カテゴリが存在する', () => {
    expect(source).toMatch(/<FaqCategory\s+title="サービスについて">/);
  });

  it('マスコットを問う質問 (フクロウ言及) を 1 件以上含む', () => {
    // ユーザがヘッダー / favicon の正体を調べたときに /help で確実に答えに辿り着けることを担保。
    expect(source).toMatch(/q="[^"]*フクロウ[^"]*"/);
  });

  it('回答内に "たすきフクロウ" の名前と 3 軸 (知恵 / 記憶 / 夜でも見守る) の象徴を含む', () => {
    expect(source).toMatch(/たすきフクロウ/);
    expect(source).toMatch(/知恵/);
    expect(source).toMatch(/記憶/);
    expect(source).toMatch(/夜でも見守る/);
  });

  it('next/image を import し /mascot-owl.png を表示する', () => {
    // モバイルでも視認できるよう Image コンポーネントで配信。
    expect(source).toMatch(/from\s+'next\/image'/);
    expect(source).toMatch(/src="\/mascot-owl\.png"/);
  });
});
