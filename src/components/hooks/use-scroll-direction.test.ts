/**
 * useScrollDirection の source-pattern 回帰テスト
 * (feat/app-header-footer-unification / 2026-05-24)。
 *
 * 採用理由:
 *   vitest 設定が `environment: 'node'` で jsdom 非導入のため、scroll イベントを
 *   発火させる behavior テストは別途環境追加が必要。`dashboard-header.test.tsx` /
 *   `app-footer.test.tsx` と同じ source-pattern 方針で invariant を担保する
 *   (KDD §5.X+114 の確立パターン)。
 *
 * カバーする invariant:
 *   - rAF + passive listener パターンが消えていない (パフォーマンス回帰防止)
 *   - 閾値 SCROLL_DIRECTION_THRESHOLD が export されている (AppHeader が参照)
 *   - SSR-safe: window 参照は useEffect 内側 (mount 後) に閉じている
 *   - cleanup で removeEventListener を呼ぶ (memory leak 防止)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOOK_FILE = join(__dirname, 'use-scroll-direction.ts');
const source = readFileSync(HOOK_FILE, 'utf8');

describe('useScrollDirection の構造 invariant', () => {
  it('SCROLL_DIRECTION_THRESHOLD を export している (AppHeader 連携で必須)', () => {
    expect(source).toMatch(/export\s+const\s+SCROLL_DIRECTION_THRESHOLD\b/);
  });

  it('requestAnimationFrame で間引いている (jank 回帰防止)', () => {
    // 直接 setState を scroll handler で呼ぶと 60fps を超える頻度で re-render が起きる。
    // rAF 経由にすることで 1 frame に 1 回に固定。
    expect(source).toMatch(/requestAnimationFrame/);
  });

  it('scroll listener が passive: true で登録されている (scroll preventDefault しない宣言)', () => {
    // 非 passive listener は scrolling thread を block する可能性があり、モバイルで
    // タッチスクロールが jank する。明示的に passive: true を渡す。
    expect(source).toMatch(/addEventListener\(\s*'scroll'[^)]*passive:\s*true/);
  });

  it('cleanup で scroll listener を removeEventListener する (memory leak 防止)', () => {
    expect(source).toMatch(/removeEventListener\(\s*'scroll'/);
  });

  it("window 参照は useEffect の内側に閉じている (SSR-safe)", () => {
    // module-top-level に `window.` 直接参照があると Next.js SSR で ReferenceError になる。
    // `typeof window` ガード or useEffect 内側に閉じ込めるのが規約。
    // 単純な heuristic: useEffect block 外で `window.` が出現しないこと。
    const beforeUseEffect = source.split('useEffect(')[0] ?? '';
    expect(beforeUseEffect).not.toMatch(/window\./);
  });

  it("初期 direction は 'up' (= 隠さない側) で、ページロード直後にチラつかせない", () => {
    // 'down' で初期化すると mount 直後に header が一瞬隠れる UX バグになる。
    expect(source).toMatch(/useState<ScrollDirection>\('up'\)/);
  });
});
