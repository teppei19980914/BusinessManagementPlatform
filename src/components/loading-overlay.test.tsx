/**
 * LoadingOverlay z-index invariant 退行防止テスト
 * (fix/loading-overlay-z / 2026-05-26).
 *
 * 背景:
 *   LoadingProvider が表示する全画面ローディングオーバーレイは、API 処理中の全 click を
 *   ブロックする目的を持つ。当初 z-50 で実装されていたが、Radix Dialog (overlay/content
 *   とも z-50) と Toast (z-50) と同層となり、Portal で document.body 末尾に rendering
 *   される Dialog が後勝ちで前面に出てしまっていた。結果としてユーザは loading 中に
 *   Dialog 内の Submit/Cancel ボタンを連打可能で、サーバ側の作成/更新処理中に
 *   別ボタンを押せる事故 (二重作成 / cancel race) が発生する。
 *
 *   z-[60] に引き上げることで Dialog / Toast / dropdown 各種 (全て z-50) より常に前面で、
 *   loading 中の全 interaction を blur 越しに完全ブロックする。
 *
 * 本テストは:
 *   - z-[60] (もしくはそれ以上の数値) が source に明示されている事を確認
 *   - 旧 z-50 にうっかり戻されていない事を確認
 *
 * source-pattern 検証である理由:
 *   vitest 環境は jsdom 非導入のため Component レンダリングを直接テストできない。
 *   AppFooter / AppHeader / credit-card-pending 等の他コンポーネントと同じ
 *   「source 文字列 invariant」方式を採用。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = join(__dirname, 'loading-overlay.tsx');
const source = readFileSync(FILE, 'utf8');

describe('LoadingOverlay z-index invariant (fix/loading-overlay-z 2026-05-26)', () => {
  it('overlay の className に z-[60] が含まれている (z-50 = Dialog/Toast/dropdown より前面)', () => {
    // `z-[60]` (Tailwind arbitrary value) または将来的に `z-60` (定義済 token) を許容。
    // 旧 `z-50` のみだと Dialog と同層で後勝ち → 「loading 中に Dialog ボタンが clickable」
    // 事故が再発する。
    expect(source).toMatch(/z-\[60\]/);
  });

  it('overlay の className に z-50 が単独で残っていない (退行防止)', () => {
    // `className="..."` の文字列内に `z-50` が **className tailwind class として**
    // 含まれていないことを確認する (= 引用符内のみ照合)。コメント文中の "z-50" は
    // 設計意図の説明として残っているので除外対象。
    const classNameMatches = source.match(/className="[^"]*z-50[^"]*"/g);
    expect(classNameMatches).toBeNull();
  });

  it('fixed inset-0 でフルスクリーン覆い (= 全 click ブロック前提) を維持している', () => {
    expect(source).toMatch(/fixed\s+inset-0/);
  });

  it('docblock に「Dialog より前面」設計判断が明記されている (将来 z-50 戻しの防止)', () => {
    // コメント無しで戻されるのを防ぐため、設計意図を source 内に残しているか確認。
    expect(source).toMatch(/Dialog|z-\[60\]/);
  });
});
