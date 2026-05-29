/**
 * middleware.ts の source-pattern 回帰テスト
 * (feat/login-mascot-and-layout-fix / 2026-05-29 / KDD §5.X+177)。
 *
 * 目的:
 *   middleware の `matcher` 設定が「public/ 配下の静的ファイルすべて」を除外して
 *   いることを担保する。
 *
 *   PR #451 (mascot 導入) 時に `/mascot-owl.png` / `/og-image.png` / `/robots.txt`
 *   が middleware の認証ガードで /login に **302 redirect** されていた重大バグを
 *   再発させないための regression test。
 *
 *   詳細: docs/knowledge/KDD_PATTERNS.md §5.X+177
 *
 * vitest 設定 environment='node' のため、middleware 関数自体の動作は test できない。
 * matcher 正規表現の文字列を読み込んで、必要な exclusion パターンが含まれているかを
 * source-pattern で担保する。実 HTTP 応答の検証は e2e/specs/17-public-static-assets.spec.ts で行う。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIDDLEWARE_FILE = join(__dirname, 'middleware.ts');
const source = readFileSync(MIDDLEWARE_FILE, 'utf8');

describe('middleware.ts matcher invariant (KDD §5.X+177 regression防止)', () => {
  it('matcher が定義されている', () => {
    expect(source).toMatch(/matcher:\s*\[/);
  });

  it('matcher exclusion に Next.js 標準パス (_next/static, _next/image, favicon.ico) を含む', () => {
    expect(source).toMatch(/_next\/static/);
    expect(source).toMatch(/_next\/image/);
    expect(source).toMatch(/favicon\.ico/);
  });

  it('matcher exclusion に public 静的ファイル拡張子 regex を含む (PR #451 潜在バグの再発防止)', () => {
    // KDD §5.X+177: middleware が /mascot-owl.png 等を /login に 302 redirect していた
    //   重大バグ。matcher に「拡張子で終わるパスは middleware を素通り」させる regex を
    //   追加することで public/ 配下の現在 / 将来のファイルすべてを一括保護する。
    //
    // パターン (source ファイル内の literal): `[^?]+\\.(?:png|jpg|jpeg|svg|webp|gif|ico|txt|xml|woff2?|ttf|eot)$`
    //   - `[^?]+`: `?` を含まない (= クエリパラメータ無し = API ルートではない)
    //   - `\\.(...)$`: 末尾が静的アセット拡張子で終わる
    //
    // includes で literal 一致を担保 (regex エスケープ困難を回避)。
    // 注: source ファイル中の `\\.` は 2 backslash + dot の 3 文字。JS string literal では `\\\\.` で表現。
    expect(source.includes('[^?]+\\\\.(?:png|jpg|jpeg|svg|webp|gif|ico|txt|xml|woff2?|ttf|eot)$')).toBe(true);
  });

  it('matcher exclusion に主要 mascot / OG / robots ファイルが拡張子 regex 経由で含まれる (PR #451 潜在バグ確認)', () => {
    // 拡張子 regex が以下の代表的なファイル群をカバーすることを文書化:
    //   - mascot-owl.png, mascot-owl-chat.png (.png)
    //   - og-image.png (.png)
    //   - robots.txt (.txt)
    //   - 将来追加: webmanifest, sitemap.xml, fonts (.woff/.woff2/.ttf/.eot)
    // ここでは「png / txt が含まれている」だけ確認 (上記の正規表現と重複するが
    // 「明示的に png と txt はカバーされる」という意図を残す)。
    const matcherLine = source.match(/matcher:\s*\[(['"])(.+?)\1\]/);
    expect(matcherLine).not.toBeNull();
    const pattern = matcherLine![2];
    expect(pattern).toContain('png');
    expect(pattern).toContain('txt');
  });

  it('matcher は API auth 関連の個別除外パスを維持している (KDD §5.X+69 / §5.X+71 / §5.X+72 で確立)', () => {
    // 既存除外: NextAuth v5 の auth() middleware による Set-Cookie 上書き事故対策で
    //   個別 API ルートを exclusion に列挙していた。本 PR の修正で消失しないことを担保。
    expect(source).toMatch(/api\/auth\/mfa\/verify/);
    expect(source).toMatch(/api\/tenants\/me\/i18n/);
    expect(source).toMatch(/api\/auth\/explicit-signout/);
  });
});
