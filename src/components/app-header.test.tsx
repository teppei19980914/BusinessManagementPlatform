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

  it('メニュー閉じ直後の即時 hide を抑止するベースライン (menuClosedAtScrollY + TOLERANCE_AFTER_MENU_CLOSE) を持つ', () => {
    // 下スクロール中にメニュー open → close 直後に stale direction='down' で hide される
    // 違和感を防ぐためのガード。実装が消えると UAT で違和感報告されるため source-pattern で確保。
    expect(source).toMatch(/menuClosedAtScrollYRef/);
    expect(source).toMatch(/TOLERANCE_AFTER_MENU_CLOSE/);
  });

  it('useReportHeaderMenuOpen を export している (NotificationBell など外部子コンポーネントから利用)', () => {
    expect(source).toMatch(/export\s+function\s+useReportHeaderMenuOpen/);
  });
});

describe('AccountMenu — Microsoft 風 アカウントメニュー invariant', () => {
  it('トリガには user 名テキストを直接出さず、人アイコン (User) + ロールアイコンのみで構成する', () => {
    // narrow viewport で名前 + バッジテキストが wrap して見切れる事故を防ぐため、
    // トリガからは可変長テキストを排除。識別情報は menu 開放時のアカウント情報セクションに集約。
    expect(source).toMatch(/User\b/); // lucide User icon import + 使用
    expect(source).toMatch(/data-testid="account-menu-trigger"/);
  });

  it('ロールアイコン (Shield / Crown) を a11y 完備 (role=img + aria-label + title + sr-only) で表示', () => {
    expect(source).toMatch(/Shield/);
    expect(source).toMatch(/Crown/);
    expect(source).toMatch(/role="img"[^>]*aria-label=\{tNav\('(super)?[Aa]dminBadge'\)\}/);
    expect(source).toMatch(/title=\{tNav\('(super)?[Aa]dminBadge'\)\}/);
    expect(source).toMatch(/className="sr-only"/);
  });

  it('トリガ button の aria-label に ユーザ名 + ロール を含め screen reader 対応', () => {
    expect(source).toMatch(/aria-label=\{[^}]*user\.name/);
  });

  it('メニュー開放時にアカウント情報セクション (氏名 + ロール + email) を表示する', () => {
    // 旧実装はトリガに名前を出していたが、Microsoft 風に menu 上部に集約。
    // 氏名は見出し、ロールとメールはアカウント情報として配置する。
    expect(source).toMatch(/data-testid="account-info-section"/);
    expect(source).toMatch(/data-testid="account-info-name"/);
    expect(source).toMatch(/data-testid="account-info-email"/);
    expect(source).toMatch(/data-testid="account-info-role"/);
    expect(source).toMatch(/\{user\.email\}/);
  });

  it('長い氏名は break-words で折返し可能、email は break-all で確実に折返し (見切れ防止)', () => {
    // truncate ではなく break-words / break-all を採用: menu 内は横幅 240px 確保しているため
    // wrap で複数行表示でも UX 上問題なく、full text を欠落させない方が情報損失が少ない。
    expect(source).toMatch(/break-words/);
    expect(source).toMatch(/break-all/);
  });

  it('旧テキストバッジ (rounded bg-info\\/20 + adminBadge / bg-amber + superAdminBadge) はトリガ上に存在しない', () => {
    // 旧 <span className="rounded bg-info/20 ...">{tNav('adminBadge')}</span> が
    // 復活すると narrow viewport 見切れ事故が再発する。
    expect(source).not.toMatch(/rounded\s+bg-info\/20[^"]*"\s*>\s*\{tNav\('adminBadge'\)/);
    expect(source).not.toMatch(/rounded\s+bg-amber-[0-9]+\/[0-9]+[^"]*"\s*>\s*\{tNav\('superAdminBadge'\)/);
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
