/**
 * dashboard-header.tsx の sticky 実装回帰テスト (KDD §5.X+114 / PR #428)
 *
 * 背景:
 *   PR #425 で `<header className="sticky top-0 z-40 ...">` を導入したが、
 *   PR #428 (本 PR) で発覚した「squash merge で `[skip netlify]` が main
 *   commit message に持ち越され Netlify Production deploy が連続 skip された
 *   罠」(= KDD §5.X+114) により、本番に sticky が反映されない期間が発生。
 *
 *   再発防止: 「コードからは sticky が消えていないこと」をテストで担保し、
 *   さらに本ファイルの存在自体が src/ 配下のコード変更として
 *   `scripts/netlify-ignore.sh` の path-based skip を回避する役目も兼ねる。
 *
 * カバーする invariant:
 *   - <header> 要素に sticky / top-0 / z-40 の 3 クラスが付与されている
 *   - z-40 が「z-30 (SortableHeader dropdown) と z-50 (AccountMenu dropdown) の
 *     間」という積層仕様 (= dropdown が header に被らない、AccountMenu が
 *     header 上に開く) を維持している
 *
 * 失敗時の対応:
 *   sticky クラスが消えたコミットがマージ対象になっている可能性が高い。
 *   コード差分を確認し、UX 影響 (= 長いページでナビにアクセス不能) を即時報告。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const HEADER_FILE = join(__dirname, 'dashboard-header.tsx');

describe('DashboardHeader sticky 実装の回帰検証 (KDD §5.X+114)', () => {
  const source = readFileSync(HEADER_FILE, 'utf8');

  it('<header> 要素の className に sticky / top-0 / z-40 が含まれている', () => {
    // 設定画面など縦に長いページでも、画面上部からナビ (テナント設定 / 全プロジェクト 等)
    // にアクセスできるようヘッダを固定する UX 要件。PR #425 で導入。
    // 本テストが fail した場合、UX 影響 severity-1 (= 長いページでナビ操作にスクロール
    // 戻りが必要、設定画面で特に顕著) を即時報告すること。
    const headerOpenTagMatch = source.match(/<header\b[^>]*className="([^"]+)"/);
    expect(headerOpenTagMatch, '<header className="..."> を含むべき').not.toBeNull();
    const headerClasses = headerOpenTagMatch?.[1] ?? '';
    expect(headerClasses).toMatch(/\bsticky\b/);
    expect(headerClasses).toMatch(/\btop-0\b/);
    expect(headerClasses).toMatch(/\bz-40\b/);
  });

  it('z-40 (header) と z-50 (AccountMenu dropdown) が同一ファイル内で共存している (積層仕様)', () => {
    // ヘッダ自体は z-40、その上に開く AccountMenu の dropdown Positioner は z-50。
    // どちらかが欠けるとアカウントメニューがヘッダ背後に隠れる UX バグになる。
    expect(source).toMatch(/\bz-40\b/);
    expect(source).toMatch(/\bz-50\b/);
  });
});
