/**
 * Public 静的アセット配信の E2E regression test
 * (feat/login-mascot-and-layout-fix / 2026-05-29 / KDD §5.X+177)。
 *
 * 目的:
 *   `public/` 配下の静的ファイル (mascot 画像 / OG image / robots.txt) が
 *   未認証 GET で **HTTP 200** を返すことを担保する。
 *
 * 背景:
 *   PR #451 (mascot 導入) 以降、middleware が `/mascot-owl.png` / `/mascot-owl-chat.png`
 *   / `/og-image.png` / `/robots.txt` を /login に **302 redirect** していた重大バグ
 *   (= 未認証ユーザが public 静的ファイルにすらアクセスできない状態) が、PR #462 で
 *   middleware matcher に静的ファイル拡張子 regex を追加することで修正された。
 *
 *   本 spec は middleware matcher 正規表現が壊れて再び 302 redirect が発生する事象を
 *   regression として検知する。
 *
 *   詳細: docs/knowledge/KDD_PATTERNS.md §5.X+177
 *
 * カバレッジ記録: docs/test/E2E_COVERAGE.md「Public 静的アセット」
 */

import { test, expect } from '@playwright/test';

test.describe('@feature:public public 静的アセット配信 (KDD §5.X+177 regression)', () => {
  // public/ 配下に実在するファイル + 「未認証 GET で 200 を返すべき」と仕様で定めたもの。
  // 追加時はここに 1 行追記する (同時に public/ にファイル配置 + middleware matcher が
  // 該当拡張子を exclusion に含んでいることを確認)。
  const PUBLIC_ASSETS: { path: string; expectedContentTypePrefix: string }[] = [
    { path: '/mascot-owl.png', expectedContentTypePrefix: 'image/png' },
    { path: '/mascot-owl-chat.png', expectedContentTypePrefix: 'image/png' },
    { path: '/og-image.png', expectedContentTypePrefix: 'image/png' },
    { path: '/robots.txt', expectedContentTypePrefix: 'text/plain' },
  ];

  for (const asset of PUBLIC_ASSETS) {
    test(`未認証 GET ${asset.path} は 200 OK を返す (302 redirect なら middleware regression)`, async ({ request }) => {
      const res = await request.get(asset.path, {
        // 302 redirect を自動追従しない (redirect されたら redirect された時点で 200 になり
        // assertion をすり抜けるため)。明示的に redirect=false で素の応答を観測する。
        maxRedirects: 0,
      });
      expect(res.status(), `${asset.path} should return 200 OK (got ${res.status()})`).toBe(200);
      const contentType = res.headers()['content-type'] ?? '';
      expect(contentType, `${asset.path} content-type should start with ${asset.expectedContentTypePrefix}`).toContain(asset.expectedContentTypePrefix);
    });
  }

  test('Image Optimizer 経由 (/_next/image) で /mascot-owl.png を取得できる (middleware が optimizer の内部 fetch を阻害していないか)', async ({ request }) => {
    // Image Optimizer は内部で source URL (= /mascot-owl.png) を fetch する。
    // middleware redirect が復活すると optimizer の内部 fetch が 302 を受け取り、
    // optimizer 自体が 400 Bad Request を返すという 2 次故障が発生する。
    // この regression を locking。
    const res = await request.get('/_next/image?url=%2Fmascot-owl.png&w=64&q=75', {
      maxRedirects: 0,
    });
    expect(res.status(), `Image Optimizer should return 200 (got ${res.status()})`).toBe(200);
  });

  test('認証保護パス (/projects) は引き続き 302 redirect を返す (middleware fix で認証ガードが破壊されていないこと)', async ({ request }) => {
    // 本 spec の主目的は静的アセット 200 の担保だが、middleware fix で「ついでに全部
    // 通っちゃう」設定ミス (例: matcher を空文字にしてしまう等) を検知するため、
    // 認証保護パスが引き続き未認証 GET で 302 を返すことも併せて担保する。
    const res = await request.get('/projects', { maxRedirects: 0 });
    expect([302, 307], `protected route should redirect (got ${res.status()})`).toContain(res.status());
    expect(res.headers()['location'] ?? '').toContain('/login');
  });
});
