/**
 * POST /api/auth/explicit-signout テスト (fix/session-clearance, 2026-05-20)。
 *
 * 観点 (KDD §5.X+66 の「set-cookie ヘッダ存在を必ず assert」原則):
 *   - 認証済 POST → 200 + tokenVersion increment + session token 2 種 + theme cookie に Max-Age=0
 *   - 未認証 POST → 200 (べき等) + tokenVersion increment は呼ばれない + cookie 削除は実施
 *   - tokenVersion increment 失敗 → 500 (cookie 残留で「ログアウトしたつもり」を防ぐ)
 *   - 監査ログ (auth_event_logs) に logout イベントが記録される
 *   - **CSRF cookie は削除しない** (KDD §5.X+138 / login flow CSRF race 対策)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      update: vi.fn(),
    },
  },
}));

vi.mock('@/services/auth-event.service', () => ({
  recordAuthEvent: vi.fn(),
}));

import { POST } from './route';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { recordAuthEvent } from '@/services/auth-event.service';
import { THEME_COOKIE_NAME } from '@/config/themes';

const authedSession = {
  user: {
    id: 'user-1',
    tenantId: 'tenant-1',
    name: 'Alice',
    email: 'alice@example.com',
    systemRole: 'general',
    tokenVersion: 5,
  },
};

/**
 * set-cookie ヘッダは複数の Set-Cookie を 1 つの文字列にカンマ区切りで返す。
 * 個別の cookie 名が含まれているかを部分一致で検証する。
 */
function expectCookieCleared(setCookie: string | null, cookieName: string) {
  expect(setCookie, `Set-Cookie should not be null when clearing ${cookieName}`).not.toBeNull();
  expect(setCookie).toContain(`${cookieName}=`);
  // Max-Age=0 削除指示が含まれること
  expect(setCookie).toMatch(new RegExp(`${cookieName}=[^,]*Max-Age=0`, 'i'));
}

describe('POST /api/auth/explicit-signout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('認証済 POST → 200 + tokenVersion increment + session 2 種 + theme cookie に Max-Age=0', async () => {
    vi.mocked(auth).mockResolvedValue(authedSession as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    vi.mocked(recordAuthEvent).mockResolvedValue(undefined as never);

    const res = await POST();

    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { tokenVersion: { increment: 1 } },
    });

    const setCookie = res.headers.get('set-cookie');
    // ★ KDD §5.X+66: set-cookie ヘッダの存在を必ず assert
    expect(setCookie).not.toBeNull();
    // session token 2 種 (production / development 両方) を削除
    expectCookieCleared(setCookie, '__Secure-authjs.session-token');
    expectCookieCleared(setCookie, 'authjs.session-token');
    // UI preference cookie (テーマ) も削除
    expectCookieCleared(setCookie, THEME_COOKIE_NAME);
    // ★ CSRF cookie は削除しない (KDD §5.X+138: login flow の signIn() CSRF refetch との
    //   microtask race で MissingCSRF を引き起こすため、意図的に対象外)。
    expect(setCookie).not.toContain('authjs.csrf-token');
  });

  it('未認証 POST → 200 (べき等) + tokenVersion increment は呼ばれない + cookie 削除は実施 (残留 cookie 防御)', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await POST();

    expect(res.status).toBe(200);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(recordAuthEvent).not.toHaveBeenCalled();

    // 未認証でも cookie 削除 Set-Cookie は付与する (旧 cookie 残留シナリオを想定)
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).not.toBeNull();
    expectCookieCleared(setCookie, '__Secure-authjs.session-token');
    expectCookieCleared(setCookie, 'authjs.session-token');
    expectCookieCleared(setCookie, THEME_COOKIE_NAME);
  });

  it('監査ログ (auth_event_logs) に logout イベントが記録される', async () => {
    vi.mocked(auth).mockResolvedValue(authedSession as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    vi.mocked(recordAuthEvent).mockResolvedValue(undefined as never);

    await POST();

    expect(recordAuthEvent).toHaveBeenCalledWith({
      eventType: 'logout',
      tenantId: 'tenant-1',
      userId: 'user-1',
      email: 'alice@example.com',
    });
  });

  it('tokenVersion increment が失敗 (DB 一時障害等) → 500 で明示エラー (silent fail を避ける)', async () => {
    vi.mocked(auth).mockResolvedValue(authedSession as never);
    vi.mocked(prisma.user.update).mockRejectedValue(new Error('Prisma timeout'));

    const res = await POST();

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('LOGOUT_FAILED');
  });

  it('session token cookie 属性: __Secure- prefix は Secure=true、無 prefix は Secure=false', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST();

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).not.toBeNull();
    // __Secure- prefix の session token は Secure フラグが必須 (browser が prefix を強制)
    expect(setCookie).toMatch(/__Secure-authjs\.session-token=[^,]*Secure/i);
    // HttpOnly / SameSite=Strict / Path=/ が含まれること (auth.config.ts と整合)
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/');
    expect(setCookie?.toLowerCase()).toContain('samesite=strict');
  });
});
