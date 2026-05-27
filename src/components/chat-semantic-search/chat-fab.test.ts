/**
 * chat-fab.tsx の source-pattern 回帰テスト (feat/chat-icon-mascot-owl 2026-05-27)。
 *
 * vitest 設定 environment='node' のため、React レンダリングを伴うテストは Playwright
 * (e2e) に委譲する。ここではユーザに見せる UI 要素の存在 invariant を担保する。
 *
 * 担保対象:
 *   - マスコット (たすきフクロウ) のアバター画像を next/image で表示
 *   - aria-label にペルソナ名 (たすきフクロウ) を含む
 *   - fixed right-4 bottom-4 の常時表示位置を維持
 *   - 旧実装の「絵文字 💬」が混入していない (回帰防止)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT_FILE = join(__dirname, 'chat-fab.tsx');
const source = readFileSync(CLIENT_FILE, 'utf8');

describe('ChatSemanticSearchFab のマスコット統合 invariant', () => {
  it('next/image を import している', () => {
    expect(source).toMatch(/from\s+'next\/image'/);
  });

  it('CHAT_PERSONA を @/config から import している (純粋定数モジュール経由)', () => {
    expect(source).toMatch(/import\s*\{[^}]*CHAT_PERSONA[^}]*\}\s*from\s*'@\/config'/);
  });

  it('aria-label にペルソナ名 (たすきフクロウ) を含む文言を生成する', () => {
    // テンプレートリテラル経由で `${CHAT_PERSONA.name}に相談する` を組み立てている。
    expect(source).toMatch(/aria-label=\{`\$\{CHAT_PERSONA\.name\}に相談する`\}/);
  });

  it('CHAT_PERSONA.avatarSrc を Image の src に渡している', () => {
    expect(source).toMatch(/src=\{CHAT_PERSONA\.avatarSrc\}/);
  });

  it('全画面右下の常時表示位置 (fixed right-4 bottom-4 z-40) を維持している', () => {
    expect(source).toMatch(/fixed right-4 bottom-4 z-40/);
  });

  it('旧実装の絵文字 💬 が source に残っていない (回帰防止)', () => {
    expect(source).not.toMatch(/💬/);
  });

  it('data-testid="chat-fab" を持つ (E2E / 視覚回帰で参照)', () => {
    expect(source).toMatch(/data-testid="chat-fab"/);
  });
});
