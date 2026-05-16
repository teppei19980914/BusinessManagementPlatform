/**
 * PR-1 (2026-05-15): /api/tenants/me/i18n (PATCH) テスト。
 *
 * 観点:
 *   - 未認証は 401
 *   - テナント管理者以外は 403
 *   - 有効値で DB 更新 + 200
 *   - 未知 TZ / 未対応 locale は 400 (DB 汚染防止)
 *   - 部分更新 (片方のみ) が可能
 *   - 空オブジェクトは現在値を 200 で返す (no-op)
 *   - ★ fix/jwt-resign-for-netlify (2026-05-18): 成功時に JWT 再署名 helper が呼ばれる
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      update: vi.fn(),
      findFirstOrThrow: vi.fn(),
    },
  },
}));

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

// JWT 再署名 helper は別途単体テストあり (src/lib/auth-jwt-helper.test.ts)。
// 本ルートテストでは「呼び出されたかどうか」を検証する。
vi.mock('@/lib/auth-jwt-helper', () => ({
  reissueAuthJwtOnResponse: vi.fn(async (_req, res, _patch) => {
    res.cookies.set('__test-reissued', 'yes', { path: '/' });
    return { ok: true };
  }),
}));

import { PATCH } from './route';
import { prisma } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { reissueAuthJwtOnResponse } from '@/lib/auth-jwt-helper';

function makeReq(body: unknown): Request {
  return new Request('http://test/api/tenants/me/i18n', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const TENANT_ID = 'tenant-uuid-1';
const adminUser = {
  id: 'user-1',
  name: 'Admin',
  email: 'a@a.co',
  systemRole: 'admin',
  tenantId: TENANT_ID,
};
const generalUser = {
  id: 'user-2',
  name: 'General',
  email: 'g@g.co',
  systemRole: 'general',
  tenantId: TENANT_ID,
};

describe('PATCH /api/tenants/me/i18n', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthenticatedUser).mockResolvedValue(adminUser as never);
  });

  it('未認証は 401', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(
      NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }) as never,
    );
    const res = await PATCH(makeReq({ timezone: 'Asia/Tokyo' }) as never);
    expect(res.status).toBe(401);
  });

  it('テナント管理者以外は 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(generalUser as never);
    const res = await PATCH(makeReq({ timezone: 'Asia/Tokyo' }) as never);
    expect(res.status).toBe(403);
  });

  it('有効な TZ + 選択可能 locale で DB 更新 + 200 + JWT 再署名 cookie が set される', async () => {
    vi.mocked(prisma.tenant.update).mockResolvedValue({
      timezone: 'America/New_York',
      locale: 'ja-JP',
    } as never);
    const res = await PATCH(
      makeReq({ timezone: 'America/New_York', locale: 'ja-JP' }) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ timezone: 'America/New_York', locale: 'ja-JP' });
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { timezone: 'America/New_York', locale: 'ja-JP' },
      select: { timezone: true, locale: true },
    });
    // ★ fix/jwt-resign-for-netlify: JWT 再署名 helper が新値で呼ばれている
    expect(reissueAuthJwtOnResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { timezone: 'America/New_York', locale: 'ja-JP' },
    );
    expect(res.headers.get('set-cookie')).toContain('__test-reissued=yes');
  });

  it('★ 認可失敗 (403) では JWT 再署名 helper を呼ばない', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(generalUser as never);
    const res = await PATCH(makeReq({ timezone: 'UTC' }) as never);
    expect(res.status).toBe(403);
    expect(reissueAuthJwtOnResponse).not.toHaveBeenCalled();
  });

  it('★ バリデーション失敗 (400) では JWT 再署名 helper を呼ばない', async () => {
    const res = await PATCH(makeReq({ timezone: 'Not/A_Zone' }) as never);
    expect(res.status).toBe(400);
    expect(reissueAuthJwtOnResponse).not.toHaveBeenCalled();
  });

  it('未知 TZ を拒否する (400, DB 更新しない)', async () => {
    const res = await PATCH(makeReq({ timezone: 'Not/A_Zone' }) as never);
    expect(res.status).toBe(400);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('未対応 locale を拒否する (400)', async () => {
    const res = await PATCH(makeReq({ locale: 'de-DE' }) as never);
    expect(res.status).toBe(400);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('部分更新: timezone のみ指定 (locale は変更されない)', async () => {
    vi.mocked(prisma.tenant.update).mockResolvedValue({
      timezone: 'UTC',
      locale: 'ja-JP',
    } as never);
    const res = await PATCH(makeReq({ timezone: 'UTC' }) as never);
    expect(res.status).toBe(200);
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { timezone: 'UTC' },
      select: { timezone: true, locale: true },
    });
  });

  it('空オブジェクトは no-op で現在値を返す', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValue({
      timezone: 'Asia/Tokyo',
      locale: 'ja-JP',
    } as never);
    const res = await PATCH(makeReq({}) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ timezone: 'Asia/Tokyo', locale: 'ja-JP' });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('不正 JSON でも 400 (500 にしない)', async () => {
    const req = new Request('http://test/api/tenants/me/i18n', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    const res = await PATCH(req as never);
    expect(res.status).toBe(400);
  });
});
