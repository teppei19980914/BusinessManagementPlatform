/**
 * AnnouncementBanner のソースパターン回帰テスト (feat/app-version-changelog-footer / 2026-05-23)。
 *
 * vitest が `environment: 'node'` のため、useEffect / localStorage の挙動を伴う
 * Client Component の render テストは別途依存追加 (jsdom + @testing-library/react) が必要。
 * 既存 dashboard-header.test.tsx (KDD §5.X+114) の方針に倣い、ソース上の invariant を
 * 検証する。
 *
 * カバーする invariant:
 *   - localStorage キー名が他箇所と衝突しない固定値である
 *   - dismiss ボタンに aria-label が付いている (a11y)
 *   - severity 4 種 (info / warning / critical / maintenance) の class 分岐がある
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(join(__dirname, 'announcement-banner.tsx'), 'utf8');

describe('AnnouncementBanner の構造 invariant', () => {
  it('localStorage キーは "tasukiba-dismissed-announcement" 固定 (衝突防止)', () => {
    expect(SOURCE).toContain('tasukiba-dismissed-announcement');
  });

  it('dismiss ボタンに aria-label が付いている (a11y)', () => {
    expect(SOURCE).toMatch(/aria-label=\{t\(['"]dismissAriaLabel['"]\)\}/);
  });

  it('severity 4 種 (info / warning / critical / maintenance) を分岐している', () => {
    expect(SOURCE).toMatch(/case 'critical'/);
    expect(SOURCE).toMatch(/case 'warning'/);
    expect(SOURCE).toMatch(/case 'maintenance'/);
    // info は default なので explicit case でも default でも OK
    expect(SOURCE).toMatch(/(case 'info'|default:)/);
  });

  it('use client ディレクティブ付き (localStorage 利用のため)', () => {
    expect(SOURCE.startsWith("'use client'")).toBe(true);
  });
});
