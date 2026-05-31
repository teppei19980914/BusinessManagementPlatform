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
 *
 * 2026-05-27 追加担保 (KDD §5.X+165):
 *   - FAB は h-16 w-16 (64×64) でバッジが全面を占有する設計
 *   - 旧 bg-background / ring-1 ring-border は撤去 (画像自体が円形バッジのため不要)
 *   - 画像は object-cover で確実にトリミング
 *   - motion-reduce 対応 (transition-none + scale-100) を完備
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

  it('全画面右下の常時表示位置 (fixed right-4 z-40 + safe-area aware bottom) を維持している', () => {
    // bottom は env(safe-area-inset-bottom) を含む別クラスに分離されている (KDD §5.X+166)。
    expect(source).toMatch(/fixed right-4 z-40/);
    expect(source).toMatch(/bottom-\[calc\(env\(safe-area-inset-bottom/);
  });

  it('旧実装の絵文字 💬 が source に残っていない (回帰防止)', () => {
    expect(source).not.toMatch(/💬/);
  });

  it('data-testid="chat-fab" を持つ (E2E / 視覚回帰で参照)', () => {
    expect(source).toMatch(/data-testid="chat-fab"/);
  });

  it('FAB サイズは h-16 w-16 (64×64) でバッジが全面を占有する', () => {
    expect(source).toMatch(/h-16 w-16/);
  });

  it('button 自体に bg-background / ring-1 は付与されていない (画像が円形バッジなので不要)', () => {
    // 旧実装は bg-primary / bg-background + ring を付けていたが、新派生画像は
    // バッジが全面を占めるため button 側の背景・縁取りは不要。
    expect(source).not.toMatch(/bg-background/);
    expect(source).not.toMatch(/ring-1 ring-border/);
  });

  it('overflow-hidden + object-cover で画像をボタン境界に確実にクリップする', () => {
    expect(source).toMatch(/overflow-hidden/);
    expect(source).toMatch(/object-cover/);
  });

  it('motion-reduce 対応: transition-none + hover:scale-100 を完備', () => {
    expect(source).toMatch(/motion-reduce:transition-none/);
    expect(source).toMatch(/motion-reduce:hover:scale-100/);
  });

  // perf/phase-4 (2026-06-01): priority を削除。FAB は画面右下の常時表示要素だが
  //   本文 LCP より優先順位を下げる方が document load 全体に有利 (preload <link> 競合解消)。
  //   loading="eager" で「画面表示後すぐ取得、優先順位は本文より下」とする。
  it('priority プロップを付与しない (本文 LCP を遅延させないため、phase-4)', () => {
    // 単独の `priority` 識別子としては Image に渡さない (コメント中の文字列マッチは許容)。
    // <Image ... priority ... /> 形式での出現を否定する: Image タグ内に priority が独立トークンで現れないこと。
    const imageBlock = source.match(/<Image[\s\S]{0,600}?\/>/);
    expect(imageBlock).not.toBeNull();
    expect(imageBlock![0]).not.toMatch(/\bpriority\b/);
  });

  it('loading="eager" を付与して画面表示後すぐの取得を担保する', () => {
    expect(source).toMatch(/loading="eager"/);
  });

  it('unoptimized を付与しない (Optimizer 経由 / KDD §5.X+177 真原因 = middleware redirect)', () => {
    // KDD §5.X+177: 当初 `unoptimized` で broken-image 事象を回避したが、真原因は
    //   middleware が /mascot-owl-chat.png を /login に 302 redirect していたこと。
    //   middleware matcher を修正したため Optimizer は復帰可能。
    expect(source).not.toMatch(/unoptimized\b/);
  });

  it('iOS safe-area-inset-bottom を加味した bottom 位置を持つ (KDD §5.X+166)', () => {
    // home indicator (portrait 34px / landscape 21px) と重ならないよう
    // env(safe-area-inset-bottom) を加算する。通常ブラウザでは 0 のため互換性 OK。
    expect(source).toMatch(/env\(safe-area-inset-bottom/);
  });

  it('dark mode 向けの shadow tweak (dark:shadow-*) を持つ (透明 PNG + dark bg 対策)', () => {
    expect(source).toMatch(/dark:shadow-/);
  });
});
