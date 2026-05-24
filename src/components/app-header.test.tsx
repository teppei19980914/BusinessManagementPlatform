/**
 * AppHeader のソースパターン回帰テスト
 * (feat/app-header-footer-unification / 2026-05-24)。
 *
 * 旧 dashboard-header.test.tsx (KDD §5.X+114) の sticky/z 同居 invariant を継承しつつ、
 * 以下を追加カバー:
 *   - ログイン状態分岐 (user!=null と user==null で別経路をレンダ)
 *   - auto-hide (translate-y-full / will-change-transform / motion-reduce 配慮)
 *   - nav の whitespace-nowrap (1366/1440px ノート PC で 1 行化担保)
 *   - flat/dropdown 切替 breakpoint が `xl:` 以上である (旧 lg: 1024px だと収まらない)
 *   - SCROLL_DIRECTION_THRESHOLD を import して使っている (先頭付近は visible 担保)
 *   - app-header-home testid が存在 (E2E spec が依存)
 *
 * source-pattern 採用理由: vitest 設定 environment='node' で jsdom 非導入のため。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HEADER_FILE = join(__dirname, 'app-header.tsx');
const source = readFileSync(HEADER_FILE, 'utf8');

describe('AppHeader の構造 invariant (旧 KDD §5.X+114 を継承)', () => {
  it('<header> 要素の className に sticky / top-0 / z-40 が含まれている', () => {
    // 設定画面など縦に長いページでも、画面上部からナビにアクセスできるようヘッダを固定する。
    // 本テストが fail した場合、UX 影響 severity-1 を即時報告する。
    expect(source).toMatch(/\bsticky\b/);
    expect(source).toMatch(/\btop-0\b/);
    expect(source).toMatch(/\bz-40\b/);
  });

  it('z-40 (header) と z-50 (AccountMenu dropdown) が同居している (積層仕様)', () => {
    expect(source).toMatch(/\bz-40\b/);
    expect(source).toMatch(/\bz-50\b/);
  });
});

describe('AppHeader の auto-hide 実装 invariant', () => {
  it('useScrollDirection / SCROLL_DIRECTION_THRESHOLD を import している', () => {
    expect(source).toMatch(/useScrollDirection/);
    expect(source).toMatch(/SCROLL_DIRECTION_THRESHOLD/);
  });

  it('hidden 時は -translate-y-full、表示時は translate-y-0 を適用する', () => {
    expect(source).toMatch(/-translate-y-full/);
    expect(source).toMatch(/translate-y-0/);
  });

  it('transition-transform + will-change-transform で jank を避ける', () => {
    expect(source).toMatch(/transition-transform/);
    expect(source).toMatch(/will-change-transform/);
  });

  it('motion-reduce 環境では transition を切る', () => {
    // prefers-reduced-motion 設定ユーザの違和感を最小化する。
    expect(source).toMatch(/motion-reduce:transition-none/);
  });

  it('メニュー開放中 (menuOpenCount > 0) は auto-hide を抑止する', () => {
    // 子の dropdown が open の間に header が消えると Portal'd dropdown が宙に浮く事故を防ぐ。
    expect(source).toMatch(/menuOpenCount\s*===\s*0/);
  });
});

describe('AppHeader の状態分岐 invariant (ログイン前後)', () => {
  it('user prop は AppHeaderUser | null を受け取る', () => {
    expect(source).toMatch(/user:\s*AppHeaderUser\s*\|\s*null/);
  });

  it('isLoggedIn が false の経路で NotificationBell / AccountMenu / nav を出さない', () => {
    // ログイン前は最低限のロゴ + ログイン CTA のみ。NotificationBell / AccountMenu は
    // 必ず `isLoggedIn && ...` ガードの内側でのみレンダされる。
    expect(source).toMatch(/isLoggedIn\s*&&\s*user\s*&&/);
  });

  it('ログイン CTA は /login ページ上では出さない (重複導線を避ける)', () => {
    expect(source).toMatch(/showLoginCta\s*=\s*!isLoggedIn\s*&&\s*pathname\s*!==\s*LOGIN_ROUTE/);
  });

  it('app-header-home testid を持つ (E2E spec 15 が依存)', () => {
    expect(source).toMatch(/data-testid="app-header-home"/);
  });
});

describe('AppHeader のナビ 1 行化 invariant', () => {
  it('flat ナビ link に whitespace-nowrap を付与している (ラベル中の改行を防ぐ)', () => {
    // FlatNavLink 内で whitespace-nowrap が付いていることを担保。
    // 消えると 1366/1440px ノート PC で 2 行になる UX 退行を起こす。
    expect(source).toMatch(/whitespace-nowrap[^"]*rounded-md\s+px-3\s+py-1\.5/);
  });

  it('flat / dropdown 切替 breakpoint は xl: 以上を使っている (旧 lg: は不可)', () => {
    // lg: (1024px) だと 11 項目のフラット表示が 1366/1440px でも 2 行になる。
    // xl: (1280px) に引き上げて flat モードが収まる幅でのみ有効化する。
    expect(source).toMatch(/\bxl:flex\b/);
    expect(source).toMatch(/\bxl:hidden\b/);
    // 旧 lg: breakpoint が残っていないこと
    expect(source).not.toMatch(/\bhidden lg:flex\b/);
    expect(source).not.toMatch(/\bflex lg:hidden\b/);
  });
});
