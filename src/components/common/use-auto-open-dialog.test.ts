/**
 * useAutoOpenDialog の再発火対応 invariant 回帰テスト
 * (PR fix/chat-search-and-auto-open / 2026-05-24)。
 *
 * 採用理由:
 *   vitest 設定が `environment: 'node'` で jsdom 非導入のため、React render 系の
 *   インタラクションテストは別途依存追加が必要。同等方針で `sortable-header.test.tsx`
 *   `dashboard-header.test.tsx` 等が source-pattern で invariant を担保している先例があり、
 *   本ファイルもそれに倣う。
 *
 * 背景:
 *   旧実装は `triggeredRef: boolean` で 1 マウント内 1 回のみ発火に固定されていた。
 *   この設計だと、ユーザがチャット意味検索で /knowledge?knowledgeId=A を開いた後、
 *   続けて /knowledge?knowledgeId=B を開こうとしても **2 件目以降が auto-open しない**
 *   (URL は変わるが dialog が出ない) という UX バグになっていた。
 *   App Router は同一 pathname 内 navigation で page component を re-mount しないため、
 *   `useRef` が保持され続けるのが直接原因。
 *
 *   対策として `lastTriggeredIdRef: string | null` に変更し、同 id への重複発火は
 *   抑止しつつ、別 id への遷移時には再発火、targetId が null (URL クリーン後) で
 *   reset、という挙動に修正した。
 *
 *   横展開: 本フックは 6 箇所 (knowledge / all-risks / all-retrospectives / all-memos /
 *   memos / stakeholders) で利用されており、いずれも同じ症状を抱えていた。
 *   hook 1 ファイルの修正で全箇所が解消する。
 *
 * カバーする invariant:
 *   1. ref の型が `string | null` であり id を記録している (boolean ではない)
 *   2. targetId が null のとき ref を null に reset する (同 id 再アクセス対応)
 *   3. `lastTriggeredIdRef.current === targetId` の早期 return がある (同 id 抑止)
 *   4. cleanUrl で **queryKey のみ** 削除する (他クエリは温存)
 *   5. router.replace を { scroll: false } で呼ぶ (画面トップへ吹き飛ばない)
 *   6. useEffect の deps に searchParams が含まれる (URL 変化検知)
 *   7. items が null / 空配列のときは判定をスキップ (初期ロード未完)
 *
 * 失敗時の対応:
 *   いずれかが落ちた場合、誰かが boolean ref に戻したか、別の重複発火抑止機構を
 *   入れたが id 比較を欠いている可能性が高い。旧実装に戻すと「チャット検索で 2 件目
 *   以降が開かない」「通知 deep link で同一画面に連続着地できない」重大 UX バグが
 *   再発する。即座に PR をブロック / レビュー必要。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_FILE = join(__dirname, 'use-auto-open-dialog.ts');
const source = readFileSync(SOURCE_FILE, 'utf8');

describe('useAutoOpenDialog 再発火対応 invariant', () => {
  it('ref は string | null 型 (boolean フラグに退行していない)', () => {
    // boolean に戻ると同一マウント内 2 回目以降の auto-open が走らない罠が再発する。
    expect(source).toMatch(/useRef<string\s*\|\s*null>/);
    // boolean リテラル useRef(false) / useRef(true) が無いこと
    expect(source).not.toMatch(/useRef\(\s*false\s*\)/);
    expect(source).not.toMatch(/useRef\(\s*true\s*\)/);
  });

  it('targetId が null のとき ref を null に reset する (同 id 再アクセス対応)', () => {
    // reset を欠くと「A を開く → 閉じる → A を再度クリック」が無反応になる。
    expect(source).toMatch(/lastTriggeredIdRef\.current\s*=\s*null/);
  });

  it('lastTriggeredIdRef.current === targetId の早期 return がある (同 id 連続発火抑止)', () => {
    // cleanUrl 反映までの useEffect 再走で onOpen が二重実行されるのを防ぐガード。
    expect(source).toMatch(/lastTriggeredIdRef\.current\s*===\s*targetId/);
  });

  it('cleanUrl は queryKey のみ削除する (他クエリは温存)', () => {
    // 一覧画面の他のクエリ (filter / sort 等) を巻き添えで消すと UX が壊れる。
    expect(source).toMatch(/URLSearchParams\(searchParams\)/);
    expect(source).toMatch(/\.delete\(queryKey\)/);
  });

  it('router.replace を { scroll: false } で呼ぶ (画面トップに吹き飛ばない)', () => {
    // dialog open 直後にスクロールがリセットされるとユーザは「何が起きた?」となる。
    expect(source).toMatch(/router\.replace\([\s\S]*scroll:\s*false/);
  });

  it('useEffect の deps に searchParams が含まれる (URL 変化検知)', () => {
    // searchParams が deps に無いと別 id への navigation で再評価されず発火しない。
    expect(source).toMatch(/\[\s*items[\s\S]*searchParams[\s\S]*\]/);
  });

  it('items が空配列のときは findで判定しない (初期ロード未完ガード)', () => {
    // 初期ロード未完で items=[] のとき auto-open が走ると常に not-found 扱いされ、
    // 後で items が埋まっても triggered 済で再評価されない罠を防ぐ。
    expect(source).toMatch(/items\.length\s*===\s*0/);
  });
});
