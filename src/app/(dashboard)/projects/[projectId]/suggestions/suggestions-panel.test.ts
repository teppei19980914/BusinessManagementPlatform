/**
 * suggestions-panel.tsx の source-pattern 回帰テスト。
 *
 * 担保対象 (feat/suggestion-tier-ux-improvement 2026-05-29):
 *   - strong tier: 初期 SUGGESTION_TIER_STRONG_INITIAL_VISIBLE (= 5) 件のみ表示、
 *     6 件目以降は「▶ さらに N 件を表示」アコーディオン (デフォルト閉じ)
 *   - medium tier: 「中程度の関連」改称 + デフォルト折りたたみ
 *     (「関連の可能性」は表示文字列から撤去)
 *   - weak tier: 既存通りデフォルト折りたたみ
 *   - 3 つの折りたたみ状態は category 単位の Set<SuggestionCategory> で独立管理
 *   - chat-panel.tsx と共有定数 SUGGESTION_TIER_STRONG_INITIAL_VISIBLE を参照
 *   - a11y: 3 つの toggle button に aria-expanded + aria-controls + 対応 id を付与
 *   - i18n: collapseStrongRest / expandStrongRest の count placeholder は両者とも
 *     strongRest.length を渡す (chat-panel と意味的に統一)
 *
 * 設計根拠: docs/specification/SUGGESTION_FEATURE.md §3.6
 * 姉妹実装: src/components/chat-semantic-search/chat-panel.tsx (2026-05-28 H-3/H-4)
 * KDD: docs/knowledge/KDD_PATTERNS.md §5.X+180 / §5.X+181
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT_FILE = join(__dirname, 'suggestions-panel.tsx');
const source = readFileSync(CLIENT_FILE, 'utf8');

describe('SuggestionsPanel 共有定数とインポート invariant', () => {
  it('SUGGESTION_TIER_STRONG_INITIAL_VISIBLE を @/config/suggestion から import している (chat-panel と共有)', () => {
    expect(source).toMatch(
      /import\s*\{[\s\S]*?SUGGESTION_TIER_STRONG_INITIAL_VISIBLE[\s\S]*?\}\s*from\s*'@\/config\/suggestion'/,
    );
  });

  it('local const STRONG_INITIAL_VISIBLE は導入されていない (DRY 維持)', () => {
    expect(source).not.toMatch(/const\s+STRONG_INITIAL_VISIBLE\s*=/);
  });

  it('strong tier の slice 分割で共有定数を使用する', () => {
    expect(source).toMatch(/slice\(0,\s*SUGGESTION_TIER_STRONG_INITIAL_VISIBLE\)/);
    expect(source).toMatch(/slice\(SUGGESTION_TIER_STRONG_INITIAL_VISIBLE\)/);
  });
});

describe('SuggestionsPanel 折りたたみ state invariant (2026-05-29 改修)', () => {
  it('expandedStrong / expandedMedium / expandedWeak の 3 つの state を保持している', () => {
    expect(source).toMatch(/const\s+\[expandedStrong,\s*setExpandedStrong\]\s*=\s*useState<Set</);
    expect(source).toMatch(/const\s+\[expandedMedium,\s*setExpandedMedium\]\s*=\s*useState<Set</);
    expect(source).toMatch(/const\s+\[expandedWeak,\s*setExpandedWeak\]\s*=\s*useState<Set</);
  });

  it('初期状態は 3 つすべて空 Set (= デフォルト折りたたみ)', () => {
    // useState<Set<...>>(new Set()) を 3 つすべてで使用。
    const matches = source.match(/useState<Set<SuggestionCategory>>\(new Set\(\)\)/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('SuggestionCategory 型に 4 カテゴリ (knowledge / issue / risk / retrospective) すべてを含む', () => {
    expect(source).toMatch(
      /type\s+SuggestionCategory\s*=\s*['"]knowledge['"]\s*\|\s*['"]issue['"]\s*\|\s*['"]risk['"]\s*\|\s*['"]retrospective['"]/,
    );
  });

  it('makeToggle helper で 3 tier の toggle 関数を共通生成する (重複ロジック解消)', () => {
    expect(source).toMatch(/const\s+makeToggle\s*=/);
    expect(source).toMatch(/const\s+toggleStrong\s*=\s*makeToggle\(setExpandedStrong\)/);
    expect(source).toMatch(/const\s+toggleMedium\s*=\s*makeToggle\(setExpandedMedium\)/);
    expect(source).toMatch(/const\s+toggleWeak\s*=\s*makeToggle\(setExpandedWeak\)/);
  });
});

describe('SuggestionsPanel renderTieredSection の UI invariant', () => {
  it('strong tier は初期 5 件 (strongInitial) + 残り (strongRest) に slice 分割する', () => {
    expect(source).toMatch(/const\s+strongInitial\s*=\s*grouped\.strong\.slice\(0,\s*SUGGESTION_TIER_STRONG_INITIAL_VISIBLE\)/);
    expect(source).toMatch(/const\s+strongRest\s*=\s*grouped\.strong\.slice\(SUGGESTION_TIER_STRONG_INITIAL_VISIBLE\)/);
  });

  it('strong tier の 6 件目以降は strongRest.length > 0 のときのみアコーディオン表示', () => {
    // `{strongRest.length > 0 && (` で条件分岐。
    expect(source).toMatch(/\{\s*strongRest\.length\s*>\s*0\s*&&/);
  });

  it('strong tier アコーディオンの count は両方向 (展開/折りたたみ) で strongRest.length に統一 (chat-panel との意味的整合 / KDD §5.X+181)', () => {
    // collapseStrongRest 側で grouped.strong.length を使うのは bug (旧実装)。
    // 両方 strongRest.length を渡すのが正解。
    expect(source).toMatch(/t\(['"]collapseStrongRest['"],\s*\{\s*count:\s*strongRest\.length\s*\}\)/);
    expect(source).toMatch(/t\(['"]expandStrongRest['"],\s*\{\s*count:\s*strongRest\.length\s*\}\)/);
    expect(source).not.toMatch(/t\(['"]collapseStrongRest['"],\s*\{\s*count:\s*grouped\.strong\.length\s*\}\)/);
  });

  it('medium tier はデフォルト折りたたみ + toggle で展開 ({isMediumExpanded && (...)})', () => {
    expect(source).toMatch(/isMediumExpanded\s*\?\s*t\(['"]collapseMediumSection['"]\)\s*:\s*t\(['"]expandMediumSection['"]\)/);
    expect(source).toMatch(/\{\s*isMediumExpanded\s*&&\s*\(/);
  });

  it('weak tier はデフォルト折りたたみを維持 (PR-X6 仕様)', () => {
    expect(source).toMatch(/isWeakExpanded\s*\?\s*t\(['"]collapseWeakSection['"]\)\s*:\s*t\(['"]expandWeakSection['"]\)/);
    expect(source).toMatch(/\{\s*isWeakExpanded\s*&&\s*\(/);
  });

  it('label の i18n キーは tierStrongLabel / tierMediumLabel / tierWeakLabel を参照', () => {
    expect(source).toMatch(/t\(['"]tierStrongLabel['"],\s*\{\s*count:\s*grouped\.strong\.length\s*\}\)/);
    expect(source).toMatch(/t\(['"]tierMediumLabel['"],\s*\{\s*count:\s*grouped\.medium\.length\s*\}\)/);
    expect(source).toMatch(/t\(['"]tierWeakLabel['"],\s*\{\s*count:\s*grouped\.weak\.length\s*\}\)/);
  });

  it('「関連の可能性」の表示文字列は撤去されている (コメント・JSDoc 上の改名理由のみ残留可)', () => {
    // ブロックコメント (JSDoc 含む) / JSX コメント / 行コメントを除いた表示文字列で確認。
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/関連の可能性/);
  });
});

describe('SuggestionsPanel アクセシビリティ (a11y) invariant', () => {
  it('3 つの toggle button すべてに aria-expanded を付与している', () => {
    expect(source).toMatch(/aria-expanded=\{isStrongRestExpanded\}/);
    expect(source).toMatch(/aria-expanded=\{isMediumExpanded\}/);
    expect(source).toMatch(/aria-expanded=\{isWeakExpanded\}/);
  });

  it('3 つの toggle button すべてに aria-controls を付与している (WCAG 1.3.1)', () => {
    expect(source).toMatch(/aria-controls=\{`suggestion-strong-rest-content-\$\{category\}`\}/);
    expect(source).toMatch(/aria-controls=\{`suggestion-medium-content-\$\{category\}`\}/);
    expect(source).toMatch(/aria-controls=\{`suggestion-weak-content-\$\{category\}`\}/);
  });

  it('aria-controls に対応するコンテンツに id 属性が付与されている', () => {
    expect(source).toMatch(/id=\{`suggestion-strong-rest-content-\$\{category\}`\}/);
    expect(source).toMatch(/id=\{`suggestion-medium-content-\$\{category\}`\}/);
    expect(source).toMatch(/id=\{`suggestion-weak-content-\$\{category\}`\}/);
  });

  it('3 つの toggle button に focus outline スタイルが付与されている (キーボード可視性)', () => {
    const focusOutlineCount = (source.match(/focus:outline-2/g) ?? []).length;
    expect(focusOutlineCount).toBeGreaterThanOrEqual(3);
  });

  it('data-testid は category 単位で識別可能 (E2E 拡張時のセレクタ安定性)', () => {
    expect(source).toMatch(/data-testid=\{`suggestion-toggle-strong-rest-\$\{category\}`\}/);
    expect(source).toMatch(/data-testid=\{`suggestion-toggle-medium-\$\{category\}`\}/);
    expect(source).toMatch(/data-testid=\{`suggestion-toggle-weak-\$\{category\}`\}/);
  });
});
