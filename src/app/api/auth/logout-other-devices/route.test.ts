/**
 * feat/logout-other-devices (2026-06-03): POST /api/auth/logout-other-devices テスト。
 *
 * 観点:
 *   - 未認証は 401
 *   - 正常系: tokenVersion increment + 新値で JWT 再署名 + auth event 記録 + 200
 *   - JWT 再署名失敗時は 500 (SESSION_REISSUE_FAILED) + auth event を記録しない
 *   - tokenVersion increment 失敗時は 500 (LOGOUT_OTHERS_FAILED) + 再署名しない
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/db', () => ({
  prisma: { user: { update: vi.fn() } },
}));

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/auth-jwt-helper', () => ({
  reissueAuthJwtOnResponse: vi.fn(async (_req, res) => {
    res.cookies.set('__test-reissued', 'yes', { path: '/' });
    return { ok: true };
  }),
}));

vi.mock('@/services/auth-event.service', () => ({
  recordAuthEvent: vi.fn(async () => {}),
}));

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(async () => {}),
}));

import { POST } from './route';
import { prisma } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { reissueAuthJwtOnResponse } from '@/lib/auth-jwt-helper';
import { recordAuthEvent } from '@/services/auth-event.service';

function makeReq(): Request {
  return new Request('http://test/api/auth/logout-other-devices', { method: 'POST' });
}

const USER = { id: 'user-1', name: 'U', email: 'u@u.co', systemRole: 'general', tenantId: 'tenant-1' };

describe('POST /api/auth/logout-other-devices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthenticatedUser).mockResolvedValue(USER as never);
    vi.mocked(prisma.user.update).mockResolvedValue({ tokenVersion: 6 } as never);
  });

  it('未認証は 401', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(
      NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }) as never,
    );
    const res = await POST(makeReq() as never);
    expect(res.status).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('正常系: tokenVersion increment + 新値で JWT 再署名 + auth event 記録 + 200', async () => {
    const res = await POST(makeReq() as never);
    expect(res.status).toBe(200);
    // tokenVersion を increment している
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });
    // 呼出端末のみ「新しい tokenVersion」で再署名 (= 現端末ログイン維持)
    expect(reissueAuthJwtOnResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { tokenVersion: 6 },
    );
    expect(res.headers.get('set-cookie')).toContain('__test-reissued=yes');
    // 監査イベント記録
    expect(recordAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'logout_other_devices', userId: 'user-1', tenantId: 'tenant-1' }),
    );
  });

  it('JWT 再署名失敗時は 500 + auth event を記録しない (フェイルセーフ)', async () => {
    vi.mocked(reissueAuthJwtOnResponse).mockResolvedValueOnce({ ok: false, reason: 'decode_failed' });
    const res = await POST(makeReq() as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('SESSION_REISSUE_FAILED');
    // tokenVersion は increment 済 (= 全端末失効済) だが、再署名失敗のため event は記録しない
    expect(prisma.user.update).toHaveBeenCalled();
    expect(recordAuthEvent).not.toHaveBeenCalled();
  });

  it('tokenVersion increment 失敗時は 500 + 再署名しない', async () => {
    vi.mocked(prisma.user.update).mockRejectedValueOnce(new Error('db down'));
    const res = await POST(makeReq() as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('LOGOUT_OTHERS_FAILED');
    expect(reissueAuthJwtOnResponse).not.toHaveBeenCalled();
    expect(recordAuthEvent).not.toHaveBeenCalled();
  });
});
