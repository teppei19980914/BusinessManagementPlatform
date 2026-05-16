/**
 * PATCH /api/settings/theme テスト。
 *
 * 観点:
 *   - 未認証は 401 (cookie も set されない)
 *   - 有効値で DB 更新 + 200 + **tasukiba-theme cookie が Set される** (★ fix/theme-preference-cookie の本丸)
 *   - 未知テーマ ID は 400 (cookie も set されない)
 *   - cookie 属性: HttpOnly / SameSite=Lax / Path=/ / Max-Age=1年
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

import { PATCH } from './route';
import { prisma } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { THEME_COOKIE_NAME } from '@/config/themes';

function makeReq(body: unknown): Request {
  return new Request('http://test/api/settings/theme', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const authedUser = {
  id: 'user-1',
  name: 'User',
  email: 'u@u.co',
  systemRole: 'general',
  tenantId: 'tenant-1',
};

describe('PATCH /api/settings/theme', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthenticatedUser).mockResolvedValue(authedUser as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: 'user-1',
      themePreference: 'dark',
    } as never);
  });

  it('未認証は 401 + cookie set されない', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(
      NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }) as never,
    );
    const res = await PATCH(makeReq({ theme: 'dark' }) as never);
    expect(res.status).toBe(401);
    // 認証で弾かれた場合は theme cookie も発行しない
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('有効値 (dark) で DB 更新 + 200 + tasukiba-theme cookie が Set される', async () => {
    const res = await PATCH(makeReq({ theme: 'dark' }) as never);
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { themePreference: 'dark' },
    });
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain(`${THEME_COOKIE_NAME}=dark`);
    // HttpOnly / Path=/ / SameSite=Lax / Max-Age=1年 が含まれること
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/');
    expect(setCookie?.toLowerCase()).toContain('samesite=lax');
    expect(setCookie).toContain(`Max-Age=${365 * 24 * 60 * 60}`);
  });

  it('別の有効値 (pastel-blue) でも cookie が更新される', async () => {
    const res = await PATCH(makeReq({ theme: 'pastel-blue' }) as never);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain(`${THEME_COOKIE_NAME}=pastel-blue`);
  });

  it('未知テーマ ID は 400 + cookie set されない (DB 汚染防止)', async () => {
    const res = await PATCH(makeReq({ theme: 'invalid-theme' }) as never);
    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
    // バリデーション失敗時は cookie も触らない
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('空 body は 400', async () => {
    const res = await PATCH(makeReq({}) as never);
    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
