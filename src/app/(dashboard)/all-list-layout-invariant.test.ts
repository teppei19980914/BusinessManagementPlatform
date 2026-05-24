/**
 * 「全○○」5 画面 (全リスク / 全課題 / 全振り返り / 全ナレッジ / 全メモ) の統一レイアウト
 * 規約の invariant 回帰テスト (feat/all-list-section-unification, 2026-05-24)。
 *
 * 統一規約 (詳細は docs/design/UI_PATTERNS.md §34):
 *   1. 件数行 = client 側で `tCommon('itemCount', { count: filteredXxx.length })` を `flex justify-end` に
 *   2. FilterBar = `<FilterBar>` で検索/フィルタ部を必ずラップ
 *   3. 検索入力に `data-testid="all-{entity}-search-input"` を付与
 *   4. テーブル本体 = `ResizableTableShell` を使う
 *   5. 詳細ダイアログ = 専用コンポーネントを使用 (memo は MemoViewDialog、他 4 画面は XxxEditDialog の readOnly)
 *   6. i18n キーは `common.itemCount` に集約 (knowledge.countUnit / memo.count は削除済)
 *
 * 採用理由:
 *   vitest は `environment: 'node'` のため React render 系テストは別途依存追加が必要。
 *   sortable-header.test.tsx 等の source-pattern テスト先例があるため本ファイルもそれに倣う。
 *
 * 失敗時の対応:
 *   誰かが偶発的にレイアウト規約を巻き戻した可能性が高い。UI_PATTERNS.md §34 を参照し
 *   どの規約が崩れたか特定して即修正。「全○○」5 画面で UI が揺れると UX 一貫性が損なわれ、
 *   ユーザの「同じ役割は同じ UI」の認識学習が破壊される (§21 ノンデザイナーズ「そろえる」)。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname);

type Screen = {
  name: string;
  file: string;
  testId: string;
  filteredVar: string;
};

const SCREENS: Screen[] = [
  {
    name: '全ナレッジ',
    file: 'knowledge/knowledge-client.tsx',
    testId: 'all-knowledge-search-input',
    filteredVar: 'filtered',
  },
  {
    // 全リスク / 全課題は同じ AllRisksTable を共有。typeFilter で testid を切替える。
    name: '全リスク・全課題 (AllRisksTable)',
    file: 'risks/all-risks-table.tsx',
    testId: 'all-risks-search-input',
    filteredVar: 'filteredRisks',
  },
  {
    name: '全振り返り',
    file: 'retrospectives/all-retrospectives-table.tsx',
    testId: 'all-retrospectives-search-input',
    filteredVar: 'filteredRetros',
  },
  {
    name: '全メモ',
    file: 'all-memos/all-memos-client.tsx',
    testId: 'all-memos-search-input',
    filteredVar: 'filteredMemos',
  },
];

function readSource(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

describe('「全○○」5 画面の統一レイアウト規約 invariant (UI_PATTERNS §34)', () => {
  describe.each(SCREENS)('$name', (screen) => {
    const source = readSource(screen.file);

    it('件数行は client 側にあり common.itemCount + フィルタ後件数 を使う', () => {
      // tCommon('itemCount', { count: <filteredVar>.length }) の形を要求。
      // 件数の母数を「フィルタ後」に統一する規約の自動検知。
      const pattern = new RegExp(
        `tCommon\\(\\s*['"]itemCount['"]\\s*,\\s*\\{\\s*count:\\s*${screen.filteredVar}\\.length`,
      );
      expect(source, `tCommon('itemCount', { count: ${screen.filteredVar}.length }) を含むべき`)
        .toMatch(pattern);
    });

    it('件数行は flex justify-end の独立行に置く', () => {
      // 件数 span を含む親 div が flex + justify-end クラスを持つこと。
      // 全メモの旧実装 (flex items-center justify-between で検索と同行) の再発を防ぐ。
      expect(source).toMatch(/flex justify-end[^"]*"[^>]*>\s*<span[^>]*text-sm[^>]*text-muted-foreground[^>]*>\s*\{tCommon\(\s*['"]itemCount['"]/);
    });

    it('検索/フィルタ部を <FilterBar> でラップしている', () => {
      // `<FilterBar>` または `<FilterBar ` (props 付き) のいずれか。
      expect(source).toMatch(/<FilterBar[\s>]/);
      expect(source).toMatch(/import\s*\{[^}]*\bFilterBar\b[^}]*\}\s*from\s*['"]@\/components\/common\/filter-bar['"]/);
    });

    it('検索入力に data-testid="all-{entity}-search-input" 規約の testid を持つ', () => {
      // 動的 testid (typeFilter で all-risks / all-issues を切替) も含めるため、
      // テンプレート式 (`${searchTestId}`) または直接文字列の両方を許容。
      const direct = new RegExp(`data-testid=["']${screen.testId}["']`);
      const dynamic = /data-testid=\{[^}]*searchTestId[^}]*\}/;
      const hasDirect = direct.test(source);
      const hasDynamic = dynamic.test(source);
      expect(hasDirect || hasDynamic, `data-testid="${screen.testId}" or {searchTestId} を含むべき`).toBe(true);
    });

    it('ResizableTableShell でテーブル本体をラップしている', () => {
      expect(source).toMatch(/<ResizableTableShell[\s>]/);
    });

    it('読み取り専用ダイアログ規約を満たす (XxxEditDialog readOnly={true} か MemoViewDialog)', () => {
      // 4 画面は専用 EditDialog の readOnly モードを使用。memo のみ MemoViewDialog。
      const usesReadOnlyEditDialog = /readOnly=\{true\}/.test(source);
      const usesMemoViewDialog = /<MemoViewDialog\b/.test(source);
      expect(
        usesReadOnlyEditDialog || usesMemoViewDialog,
        '<XxxEditDialog readOnly={true} /> または <MemoViewDialog /> のいずれかを使うべき',
      ).toBe(true);
    });
  });

  describe('「全リスク」「全課題」の AllRisksTable は typeFilter で testid を切替える', () => {
    const source = readSource('risks/all-risks-table.tsx');

    it('all-issues-search-input testid も導出される (typeFilter="issue" 時)', () => {
      // 共通 component が 2 つの route (/risks, /issues) で使われるため、
      // searchTestId に 'all-issues-search-input' の文字列が現れること。
      expect(source).toMatch(/['"]all-issues-search-input['"]/);
      expect(source).toMatch(/['"]all-risks-search-input['"]/);
    });
  });

  describe('i18n キーが common.itemCount に集約されている', () => {
    const ja = readFileSync(
      join(ROOT, '..', '..', 'i18n', 'messages', 'ja.json'),
      'utf8',
    );
    const en = readFileSync(
      join(ROOT, '..', '..', 'i18n', 'messages', 'en-US.json'),
      'utf8',
    );

    it('common.itemCount キーが存在する', () => {
      expect(ja).toMatch(/"itemCount":\s*"\{count\}/);
      expect(en).toMatch(/"itemCount":\s*"\{count\}/);
    });

    it('旧 knowledge.countUnit キーは削除されている', () => {
      // knowledge ネームスペース直下から countUnit を消したことを保証。
      // 残っていると tKnowledge('countUnit') 呼出と二重定義状態になり一元化が崩れる。
      expect(ja).not.toMatch(/"countUnit":\s*"\{count\}/);
      expect(en).not.toMatch(/"countUnit":\s*"\{count\}/);
    });

    it('旧 memo.count キー ("{count} 件" 形式) は削除されている', () => {
      // myTask.count = "({count} 件)" は括弧付きで別用途、削除対象外。
      // memo namespace の plain "{count} 件" が削除されていること。
      const memoNamespaceMatch = ja.match(/"memo":\s*\{[\s\S]*?\n\s\s\},/);
      expect(memoNamespaceMatch).not.toBeNull();
      const memoBlock = memoNamespaceMatch?.[0] ?? '';
      expect(memoBlock).not.toMatch(/"count":\s*"\{count\}\s*件"/);
    });
  });
});
