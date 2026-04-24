/**
 * PR #119: /api/settings/i18n (PATCH) テスト。
 *
 * 観点:
 *   - 未認証は 401
 *   - 有効値で DB 更新 + 200
 *   - 未知 TZ / 未対応 locale は 400 (DB 汚染防止)
 *   - null 指定でシステム既定に戻せる
 *   - 部分更新 (片方のみ) が可能
 *   - 空オブジェクトは現在値を 200 で返す (no-op)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      update: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

import { PATCH } from './route';
import { prisma } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/api-helpers';

function makeReq(body: unknown): Request {
  return new Request('http://test/api/settings/i18n', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const mockUser = { id: 'user-1', name: 'Test', email: 't@t.co', systemRole: 'general' };

describe('PATCH /api/settings/i18n', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthenticatedUser).mockResolvedValue(mockUser as never);
  });

  it('未認証は 401', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(
      NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }) as never,
    );
    const res = await PATCH(makeReq({ timezone: 'Asia/Tokyo' }) as never);
    expect(res.status).toBe(401);
  });

  it('有効な TZ + 選択可能 locale で DB 更新 + 200', async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({
      timezone: 'America/New_York',
      locale: 'ja-JP',
    } as never);
    const res = await PATCH(makeReq({ timezone: 'America/New_York', locale: 'ja-JP' }) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ timezone: 'America/New_York', locale: 'ja-JP' });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { timezone: 'America/New_York', locale: 'ja-JP' },
      select: { timezone: true, locale: true },
    });
  });

  it('PR #120: SELECTABLE_LOCALES=false な en-US は 400 で拒否 (UI disabled の迂回防止)', async () => {
    const res = await PATCH(makeReq({ locale: 'en-US' }) as never);
    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('未知 TZ を拒否する (400, DB 更新しない)', async () => {
    const res = await PATCH(makeReq({ timezone: 'Not/A_Zone' }) as never);
    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('未対応 locale を拒否する (400)', async () => {
    const res = await PATCH(makeReq({ locale: 'de-DE' }) as never);
    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('null 指定でシステム既定に戻す', async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({
      timezone: null,
      locale: null,
    } as never);
    const res = await PATCH(makeReq({ timezone: null, locale: null }) as never);
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { timezone: null, locale: null },
      select: { timezone: true, locale: true },
    });
  });

  it('部分更新: timezone のみ指定 (locale は変更されない)', async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({
      timezone: 'UTC',
      locale: 'ja-JP',
    } as never);
    const res = await PATCH(makeReq({ timezone: 'UTC' }) as never);
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { timezone: 'UTC' },
      select: { timezone: true, locale: true },
    });
  });

  it('空オブジェクトは no-op で現在値を返す', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      timezone: 'Asia/Tokyo',
      locale: 'ja-JP',
    } as never);
    const res = await PATCH(makeReq({}) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ timezone: 'Asia/Tokyo', locale: 'ja-JP' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('不正 JSON でも 400 (500 にしない)', async () => {
    const req = new Request('http://test/api/settings/i18n', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    const res = await PATCH(req as never);
    expect(res.status).toBe(400);
  });
});
