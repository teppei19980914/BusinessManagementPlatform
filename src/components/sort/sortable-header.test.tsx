/**
 * SortableHeader の Portal 化 invariant 回帰テスト
 * (PR fix/sortable-header-dropdown-portal / 2026-05-24).
 *
 * 採用理由:
 *   vitest 設定が `environment: 'node'` で jsdom 非導入のため、React render 系の
 *   インタラクションテストは別途依存追加が必要。同等方針で `dashboard-header.test.tsx`
 *   `app-footer.test.tsx` が source-pattern で invariant を担保している先例があるため、
 *   本ファイルもそれに倣う。
 *
 * 背景:
 *   旧実装は dropdown を `position: absolute` で trigger 直下に置いていたが、
 *   親 `ResizableHead` の `<div className="truncate pr-2">` が `overflow: hidden` を持つため
 *   (Tailwind `truncate` ユーティリティの定義), 絶対配置子要素は content box でクリップされて
 *   完全不可視 = ユーザは ↑昇順 / ↓降順 / ×クリア のいずれも選択不能 = ソート機能 dead 化
 *   していた。同時に Table の wrapper も `overflow: auto` を持つため `truncate` だけ解消しても
 *   右端カラムで二次クリップが起きる構造。
 *
 *   対策として `createPortal` で `document.body` 直下に dropdown を出す Portal 化を採用。
 *   本テストはその Portal 化に伴う必須実装ポイントを source-pattern で固定する。
 *
 * カバーする invariant:
 *   1. `createPortal` を `react-dom` から import している
 *   2. `document.body` を Portal target に渡している
 *   3. trigger と menu の 2 つの ref を持ち、click-outside 判定で両方を contains チェックしている
 *      (片方だけだと menu 内クリックが「外」と誤判定されて即 close する罠)
 *   4. `z-50` を menu に付与している (sticky header z-40 より前面に積層)
 *   5. SSR ガード (`mounted` flag) があり、client mount 後にのみ Portal を有効化している
 *      (createPortal は server で document 不在のため)
 *   6. scroll / resize で close する listener が存在し、`capture: true` で内部スクロールも捕捉
 *      (座標が陳腐化するため。table-container の overflow-auto 内スクロールも対象)
 *   7. ESC キーで close する listener が存在する
 *   8. data-testid="sortable-header-menu" が menu 要素に付与されている (E2E selector)
 *
 * 失敗時の対応:
 *   いずれかが落ちた場合、誰かが Portal 化を巻き戻したか必須サブ機能を欠いた可能性が高い。
 *   旧実装に戻すと「dropdown が overflow:hidden でクリップされてソート完全 dead」の重大 UX
 *   バグが再発する。即座に PR をブロック / レビュー必要。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_FILE = join(__dirname, 'sortable-header.tsx');
const source = readFileSync(SOURCE_FILE, 'utf8');

describe('SortableHeader Portal 化 invariant', () => {
  it('createPortal を react-dom から import している', () => {
    expect(source).toMatch(/import\s*\{[^}]*\bcreatePortal\b[^}]*\}\s*from\s*['"]react-dom['"]/);
  });

  it('createPortal の target に document.body を指定している', () => {
    // ターゲットを body 直下にすることで任意祖先の overflow から独立する。
    // 別 element (例: #__next 配下) を target にすると再びクリップされうる。
    expect(source).toMatch(/createPortal\s*\([\s\S]*document\.body/);
  });

  it('trigger ref と menu ref の 2 つを保持している', () => {
    // Portal 化で menu が DOM tree 外に出るため、click-outside 判定では trigger ref と
    // menu ref の **両方** を contains チェックしないと menu 内クリックが「外」と
    // 誤判定されて即 close する。
    expect(source).toMatch(/triggerRef\s*=\s*useRef/);
    expect(source).toMatch(/menuRef\s*=\s*useRef/);
  });

  it('click-outside 判定で trigger と menu の両方を contains チェックしている', () => {
    expect(source).toMatch(/triggerRef\.current\?\.contains/);
    expect(source).toMatch(/menuRef\.current\?\.contains/);
  });

  it('menu の className に z-50 を付与している (sticky header z-40 より前面)', () => {
    // dashboard-header が z-40 のため、menu を body 直下に出しても z-30 等だと
    // ヘッダ背後に隠れる。z-50 が Dialog overlay と同層で安全な前面化。
    expect(source).toMatch(/z-50/);
  });

  it('mounted flag による SSR ガードを持つ (client mount 後のみ Portal レンダー)', () => {
    // createPortal は server で document 不在のため、mount 前に呼ぶと throw する。
    // useState + useEffect で mounted を遅延 true 化する pattern を要求。
    expect(source).toMatch(/setMounted\(true\)/);
    expect(source).toMatch(/mounted\s*&&\s*open/);
  });

  it('scroll / resize で close する listener を持つ (capture:true で内部スクロールも捕捉)', () => {
    // capture: true がないと table-container の overflow-auto 内 scroll を取り逃して
    // 座標がずれた状態の menu が残る。座標再計算より単純な close を採用。
    expect(source).toMatch(/addEventListener\(\s*['"]scroll['"][\s\S]*true/);
    expect(source).toMatch(/addEventListener\(\s*['"]resize['"]/);
  });

  it('ESC キーで close する listener を持つ (a11y / 標準操作)', () => {
    expect(source).toMatch(/['"]Escape['"]/);
    expect(source).toMatch(/addEventListener\(\s*['"]keydown['"]/);
  });

  it('menu 要素に data-testid="sortable-header-menu" が付与されている (E2E selector)', () => {
    // E2E spec (e2e/specs/16-column-sort.spec.ts) がこの selector で menu の visible 検証
    // を行うため、変更時は spec の selector も同時に追従させる必要あり。
    expect(source).toMatch(/data-testid="sortable-header-menu"/);
  });

  it('button trigger に data-testid="sortable-header-button" / data-column-key を保持 (既存 selector 互換)', () => {
    // Portal 化前から存在する selector。後方互換のため維持必須。
    expect(source).toMatch(/data-testid="sortable-header-button"/);
    expect(source).toMatch(/data-column-key=/);
  });

  it('menu の position は fixed (座標は getBoundingClientRect ベース)', () => {
    // Portal 化で body 直下に出すため、絶対配置 (= 直近 positioned ancestor 相対) ではなく
    // viewport 相対の fixed を採用。getBoundingClientRect も viewport 相対のため整合する。
    expect(source).toMatch(/className="fixed/);
    expect(source).toMatch(/getBoundingClientRect/);
  });
});
