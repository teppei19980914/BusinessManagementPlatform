/**
 * AppFooter のソースパターン回帰テスト (feat/app-version-changelog-footer / 2026-05-23)。
 *
 * 採用理由:
 *   vitest 設定が `environment: 'node'` で jsdom 非導入のため、React Component の
 *   render 系テストは別途依存追加が必要。本ファッターは Server Component (`async` +
 *   `getTranslations`) で、コミットメッセージや translation 注入を伴わずに render 検証
 *   するハードルが高い。同等の方針で `dashboard-header.test.tsx` が source-pattern で
 *   sticky invariant を担保している (KDD §5.X+114) 先例があるため、本ファイルもそれに
 *   倣う。
 *
 * カバーする invariant:
 *   - <footer> タグが存在する (semantic HTML)
 *   - `mt-auto` クラスが付与されている (root layout の flex-col で最下段に押し下げる仕組み)
 *   - 内部リンク (/settings/about, /changelog, /announcements) が含まれる
 *   - 外部リンク (TERMS_URL, PRIVACY_URL, CONTACT_FORM_URL) が rel="noopener noreferrer" 付きで含まれる
 *   - バージョン表示ヘルパ formatVersionLabel と運営者定数 OPERATOR_NAME を参照している
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FOOTER_FILE = join(__dirname, 'app-footer.tsx');
const source = readFileSync(FOOTER_FILE, 'utf8');

describe('AppFooter の構造 invariant', () => {
  it('<footer> 要素を持つ (semantic HTML)', () => {
    expect(source).toMatch(/<footer\b/);
  });

  it('mt-auto クラスを持つ (root layout の flex-col で最下段に押し下げる)', () => {
    // body の `flex min-h-full flex-col` 構造に依存し、children に flex-1 を要求しない
    // ことが本コンポーネントの設計上の前提。`mt-auto` が消えると children が短い画面で
    // フッターが画面中央に浮く layout 不具合になる。
    expect(source).toMatch(/\bmt-auto\b/);
  });

  it('内部リンク /settings/about /changelog /announcements を含む', () => {
    expect(source).toMatch(/href="\/settings\/about"/);
    expect(source).toMatch(/href="\/changelog"/);
    expect(source).toMatch(/href="\/announcements"/);
  });

  it('外部リンクは target="_blank" rel="noopener noreferrer" を持つ (tabnabbing 対策)', () => {
    // 外部リンクは少なくとも 3 つ (TERMS / PRIVACY / CONTACT) 想定。
    // rel="noopener noreferrer" の付与漏れは reverse tabnabbing の入口になる。
    const externalAnchorMatches = source.match(/<a\s+[^>]*target="_blank"[^>]*>/g) ?? [];
    expect(externalAnchorMatches.length).toBeGreaterThanOrEqual(3);
    for (const tag of externalAnchorMatches) {
      expect(tag).toMatch(/rel="noopener noreferrer"/);
    }
  });

  it('バージョン表示と運営者定数を参照している', () => {
    expect(source).toMatch(/formatVersionLabel/);
    expect(source).toMatch(/OPERATOR_NAME/);
  });

  it('TERMS_URL / PRIVACY_URL / CONTACT_FORM_URL を直接 import している (URL hardcode を避ける)', () => {
    expect(source).toMatch(/TERMS_URL/);
    expect(source).toMatch(/PRIVACY_URL/);
    expect(source).toMatch(/CONTACT_FORM_URL/);
  });
});
