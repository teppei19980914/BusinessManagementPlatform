import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * perf/comprehensive-perf-2026-06-01 (E) 回帰テスト:
 *   /api/auth/session の過剰 fetch (1 ページで 4 回、累計 ~3s) を防ぐため、
 *   SessionProvider に下記 2 props を渡すよう要件化する。本テストは「将来 props を
 *   外した PR を CI で防ぐ」回帰ガード。
 *
 *   - refetchInterval={0}
 *   - refetchOnWindowFocus={false}
 *
 * セキュリティ境界: middleware (src/middleware.ts) と layout DB 照合
 *   (src/lib/page-auth.ts) が全 server request で tokenVersion を検証するため、
 *   クライアント側 session の自動 refresh は不要 (= 越境リスクは追加されない)。
 *   明示的な useSession().update() (settings/themePreference 等) は本設定とは独立に
 *   引き続き動作する。
 */
describe('AppSessionProvider invariant (perf/comprehensive-perf-2026-06-01 E)', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/components/session-provider.tsx'),
    'utf-8',
  );

  it('refetchInterval={0} が SessionProvider に渡される', () => {
    expect(source).toMatch(/refetchInterval=\{0\}/);
  });

  it('refetchOnWindowFocus={false} が SessionProvider に渡される', () => {
    expect(source).toMatch(/refetchOnWindowFocus=\{false\}/);
  });

  it('session prop は引き続き SSR 由来の初期値として渡される (PR #119 維持)', () => {
    // SSR で取得した session が SessionProvider 初期値として渡る経路を維持。
    // これを外すと useSession() の第 1 レンダリングが undefined → fetch 再描画になる。
    expect(source).toMatch(/session=\{session\}/);
  });
});
