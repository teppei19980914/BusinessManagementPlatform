/**
 * 「プロジェクト配下 CRUD 一覧画面」3 画面 (risks / knowledge / retrospectives) の
 * 統一レイアウト規約 invariant 回帰テスト (feat/all-list-section-unification, 2026-05-24)。
 *
 * 統一規約 (詳細は docs/design/UI_PATTERNS.md §35):
 *   1. CrossListBulkVisibilityToolbar による visibility-only 一括編集を使用
 *   2. ResizableTableShell + SortableResizableHead + ClickableRow による軽量テーブル
 *   3. 編集ダイアログは XxxEditDialog (readOnly は own/other 判定で動的)
 *   4. multiSort + useMultiSort によるソート永続化
 *   5. mineOnly 系の絞り込みを bulkFilter で表現
 *   6. AttachmentsCell で添付列を表示
 *
 * §34 と異なる点 (§35.3 差分一覧参照):
 *   - 一括編集: 全○○は無し / project配下は CrossListBulkVisibilityToolbar
 *   - 列構成: 全○○は詳細列含む / project配下は軽量列のみ (詳細は行クリック dialog)
 *   - 行クリック: 全○○は readOnly=true / project配下は own 判定で readOnly 切替
 *
 * 失敗時の対応:
 *   誰かが偶発的に §35 規約を巻き戻した可能性が高い。UI_PATTERNS.md §35 を参照し
 *   どの規約が崩れたか特定して即修正。リスク/課題/ナレッジ/振り返り/メモの 5 一覧で
 *   UI が揺れると UX 一貫性が損なわれ、ユーザの「同じ役割は同じ UI」の認識学習が
 *   破壊される (§21 ノンデザイナーズ「そろえる」)。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname);

type Screen = {
  name: string;
  file: string;
  /** sortState の sessionStorage キー prefix (useMultiSort 引数) */
  sortKey: string;
};

const SCREENS: Screen[] = [
  {
    name: 'project リスク/課題 (RisksClient)',
    file: 'risks/risks-client.tsx',
    sortKey: 'sort:project-risks',
  },
  {
    name: 'project ナレッジ',
    file: 'knowledge/project-knowledge-client.tsx',
    sortKey: 'sort:project-knowledge-',
  },
  {
    name: 'project 振り返り',
    file: 'retrospectives/retrospectives-client.tsx',
    sortKey: 'sort:project-retrospectives-',
  },
];

function readSource(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

describe('「プロジェクト配下 CRUD 一覧」3 画面の統一レイアウト規約 invariant (UI_PATTERNS §35)', () => {
  describe.each(SCREENS)('$name', (screen) => {
    const source = readSource(screen.file);

    it('CrossListBulkVisibilityToolbar を import + 使用している (visibility-only 一括編集)', () => {
      // §35.4: 5 一覧画面で visibility-only 一括編集に統一。複合 patch dialog は撤廃。
      expect(source).toMatch(
        /import\s*\{[^}]*\bCrossListBulkVisibilityToolbar\b[^}]*\}\s*from\s*['"]@\/components\/cross-list-bulk-visibility-toolbar['"]/,
      );
      expect(source).toMatch(/<CrossListBulkVisibilityToolbar[\s\n]/);
    });

    it('ResizableTableShell + SortableResizableHead + ClickableRow による軽量テーブルを使う', () => {
      expect(source).toMatch(/<ResizableTableShell[\s>]/);
      expect(source).toMatch(/<SortableResizableHead[\s\n]/);
      expect(source).toMatch(/<ClickableRow[\s\n]/);
    });

    it('useMultiSort + multiSort でソート永続化 + 適用している', () => {
      expect(source).toMatch(/useMultiSort\(\s*['"`]/);
      expect(source).toMatch(/multiSort\(/);
    });

    it('useMultiSort の sessionStorage キーが project-{entity} 規約に従う', () => {
      const re = new RegExp(`useMultiSort\\(\\s*['"\`]${screen.sortKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      expect(source, `useMultiSort('${screen.sortKey}…') を含むべき`).toMatch(re);
    });

    it('BulkSelectHeader + BulkSelectCell でテーブル先頭に選択列を持つ', () => {
      expect(source).toMatch(/<BulkSelectHeader[\s\n]/);
      expect(source).toMatch(/<BulkSelectCell[\s\n]/);
    });

    it('mineOnly フィルター state を持つ (「自分が作成したもののみ」)', () => {
      // bulkFilter.mineOnly または filter.mineOnly のいずれか経路で参照されること
      expect(source).toMatch(/\bmineOnly\b/);
    });

    it('行クリックで編集ダイアログを開く (readOnly 判定付き)', () => {
      // RetrospectiveEditDialog / KnowledgeEditDialog / RiskEditDialog いずれかの readOnly prop
      expect(source).toMatch(/readOnly=\{[^}]*currentUserId[^}]*\}|readOnly=\{[^}]*===[^}]*\}|readOnly=\{[^}]*!==[^}]*\}/);
    });

    it('AttachmentsCell で添付列を表示している', () => {
      expect(source).toMatch(/<AttachmentsCell[\s\n]/);
    });

    it('ClickableCard を使っていない (カード→軽量テーブル化済)', () => {
      // §35: 全 5 画面でテーブル形式に統一。ClickableCard import / 使用が残っていれば回帰。
      expect(source, 'ClickableCard 残置は §35 違反 (カード→テーブル化が未完了)').not.toMatch(/\bClickableCard\b/);
    });
  });

  describe('リスク/課題 bulk API (visibility-only) の整合性', () => {
    it('旧 risk-bulk.ts validator は削除済', () => {
      // UI_PATTERNS §35: state+assigneeId+deadline 複合 patch は撤廃。
      // 旧 src/lib/validators/risk-bulk.ts が残っていると未使用コードによる混乱を招く。
      let exists = false;
      try {
        readFileSync(
          join(ROOT, '..', '..', '..', '..', 'lib', 'validators', 'risk-bulk.ts'),
          'utf8',
        );
        exists = true;
      } catch {
        exists = false;
      }
      expect(exists, '旧 src/lib/validators/risk-bulk.ts は削除済であるべき').toBe(false);
    });

    it('cross-list-bulk-visibility.ts に bulkUpdateRiskVisibilitySchema が定義されている', () => {
      const src = readFileSync(
        join(ROOT, '..', '..', '..', '..', 'lib', 'validators', 'cross-list-bulk-visibility.ts'),
        'utf8',
      );
      expect(src).toMatch(/export\s+const\s+bulkUpdateRiskVisibilitySchema\b/);
      expect(src).toMatch(/visibility:\s*z\.enum\(\[['"]draft['"],\s*['"]public['"]\]\)/);
    });

    it('/api/projects/[id]/risks/bulk/route.ts は新 validator + visibility-only service を使う', () => {
      const src = readFileSync(
        join(ROOT, '..', '..', '..', '..', 'app', 'api', 'projects', '[projectId]', 'risks', 'bulk', 'route.ts'),
        'utf8',
      );
      expect(src).toMatch(/bulkUpdateRiskVisibilitySchema/);
      expect(src).toMatch(/bulkUpdateRisksVisibilityFromList/);
      // 旧シグネチャの痕跡 (patch.state / patch.assigneeId / patch.deadline) が残っていないこと
      expect(src).not.toMatch(/patch\.state|patch\.assigneeId|patch\.deadline/);
    });

    it('risk.service.ts の旧 bulkUpdateRisksFromList は削除/改名済 (visibility-only に統合)', () => {
      const src = readFileSync(
        join(ROOT, '..', '..', '..', '..', 'services', 'risk.service.ts'),
        'utf8',
      );
      expect(src).toMatch(/export\s+async\s+function\s+bulkUpdateRisksVisibilityFromList\b/);
      expect(src, '旧 bulkUpdateRisksFromList 関数は撤廃済であるべき')
        .not.toMatch(/export\s+async\s+function\s+bulkUpdateRisksFromList\b/);
    });
  });
});
