/**
 * POST /api/auth/mfa/verify テスト。
 *
 * 観点 (デグレ防止):
 *   - 未認証は 401
 *   - 自分以外の userId を渡すと 403 (他人 TOTP の検証拒否)
 *   - TOTP 成功時: 200 + **JWT 再署名 cookie が Set される** (★ fix/jwt-resign-for-netlify の本丸)
 *   - TOTP 失敗時: 400 + cookie 発行しない
 *   - MFA ロック中: 429
 *   - recovery code 成功時: 200 + JWT 再署名 cookie が Set される
 *   - recovery code 失敗時: 400 + cookie 発行しない
 *
 * mfaVerified=true への再署名は `reissueAuthJwtOnResponse` (auth-jwt-helper) に委譲。
 * 当該ヘルパ自体の単体テストは src/lib/auth-jwt-helper.test.ts を参照。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  prisma: {
    recoveryCode: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    // fix/session-clearance follow-up (2026-05-20): tokenVersion 検証用 (KDD §5.X+84)
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/services/mfa.service', () => ({
  verifyTotp: vi.fn(),
  resetMfaLockOnRecoveryCodeUse: vi.fn(),
  // MfaLockedError は route が instanceof チェックで使うため、同じ shape の class を提供
  MfaLockedError: class MfaLockedError extends Error {
    constructor(public lockedUntil: Date) {
      super('MFA_LOCKED');
      this.name = 'MfaLockedError';
    }
  },
}));

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));

// JWT 再署名ヘルパは独立テスト済 (src/lib/auth-jwt-helper.test.ts)。
// 本ルートテストでは「呼び出されたかどうか + cookie が set されたか」を間接的に検証する。
vi.mock('@/lib/auth-jwt-helper', () => ({
  reissueAuthJwtOnResponse: vi.fn(async (_req, res, _patch) => {
    // テスト用に固定値の Set-Cookie を付けることで、ルート側が helper を呼び出したことを検証する
    res.cookies.set('__test-reissued', 'yes', { path: '/' });
    return { ok: true };
  }),
}));

import { POST } from './route';
import { verifyTotp, MfaLockedError } from '@/services/mfa.service';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { compare } from 'bcryptjs';
import { reissueAuthJwtOnResponse } from '@/lib/auth-jwt-helper';

vi.mock('bcryptjs', () => ({ compare: vi.fn() }));

// Zod v4 の z.string().uuid() は version + variant を厳格検証するため、
// 妥当な UUID v4 (version=4, variant=8/9/a/b) を使用する。
const USER_ID = '550e8400-e29b-41d4-a716-446655440000';

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://test/api/auth/mfa/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/mfa/verify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({
      user: { id: USER_ID, tokenVersion: 0 },
    } as never);
    // fix/session-clearance follow-up (2026-05-20): tokenVersion 検証用の DB mock を既定で成功状態に
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      tokenVersion: 0,
      isActive: true,
      deletedAt: null,
    } as never);
  });

  it('未認証は 401', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(makeReq({ userId: USER_ID, code: '123456' }));
    expect(res.status).toBe(401);
    expect(reissueAuthJwtOnResponse).not.toHaveBeenCalled();
  });

  it('自分以外の userId を渡すと 403', async () => {
    const res = await POST(
      makeReq({ userId: '22222222-2222-2222-2222-222222222222', code: '123456' }),
    );
    expect(res.status).toBe(403);
    expect(reissueAuthJwtOnResponse).not.toHaveBeenCalled();
  });

  // fix/session-clearance follow-up (2026-05-20): tokenVersion 検証 (KDD §5.X+84)
  it('JWT tokenVersion が DB と不一致なら 401 SESSION_INVALIDATED (explicit-signout 経由 increment)', async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID, tokenVersion: 0 } } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      tokenVersion: 1, // DB 側は logout で increment 済
      isActive: true,
      deletedAt: null,
    } as never);
    const res = await POST(makeReq({ userId: USER_ID, code: '123456' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('SESSION_INVALIDATED');
    expect(reissueAuthJwtOnResponse).not.toHaveBeenCalled();
  });

  it('対象ユーザが削除済 (deletedAt != null) なら 401', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      tokenVersion: 0,
      isActive: true,
      deletedAt: new Date(),
    } as never);
    const res = await POST(makeReq({ userId: USER_ID, code: '123456' }));
    expect(res.status).toBe(401);
    expect(reissueAuthJwtOnResponse).not.toHaveBeenCalled();
  });

  it('対象ユーザが無効化済 (isActive=false) なら 401', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      tokenVersion: 0,
      isActive: false,
      deletedAt: null,
    } as never);
    const res = await POST(makeReq({ userId: USER_ID, code: '123456' }));
    expect(res.status).toBe(401);
    expect(reissueAuthJwtOnResponse).not.toHaveBeenCalled();
  });

  it('TOTP 成功時: 200 + JWT 再署名 helper が呼ばれ Set-Cookie される', async () => {
    vi.mocked(verifyTotp).mockResolvedValue(true);
    const res = await POST(makeReq({ userId: USER_ID, code: '123456' }));
    expect(res.status).toBe(200);
    // ★ helper が mfaVerified: true で呼ばれていること
    expect(reissueAuthJwtOnResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { mfaVerified: true },
    );
    // 再署名 cookie が response に含まれること (mock の固定値で確認)
    expect(res.headers.get('set-cookie')).toContain('__test-reissued=yes');
  });

  it('TOTP 失敗時: 400 + cookie 発行しない', async () => {
    vi.mocked(verifyTotp).mockResolvedValue(false);
    const res = await POST(makeReq({ userId: USER_ID, code: '999999' }));
    expect(res.status).toBe(400);
    expect(reissueAuthJwtOnResponse).not.toHaveBeenCalled();
  });

  it('MFA ロック中: 429 + cookie 発行しない', async () => {
    vi.mocked(verifyTotp).mockImplementation(() => {
      throw new MfaLockedError(new Date(Date.now() + 30 * 60 * 1000));
    });
    const res = await POST(makeReq({ userId: USER_ID, code: '123456' }));
    expect(res.status).toBe(429);
    expect(reissueAuthJwtOnResponse).not.toHaveBeenCalled();
  });

  it('recovery code 成功時: 200 + JWT 再署名 helper が呼ばれ Set-Cookie される', async () => {
    vi.mocked(prisma.recoveryCode.findMany).mockResolvedValue([
      { id: 'rc1', codeHash: 'hashed' },
    ] as never);
    vi.mocked(compare).mockResolvedValue(true as never);

    const res = await POST(
      makeReq({ userId: USER_ID, recoveryCode: 'TEST-RECOVERY-CODE' }),
    );
    expect(res.status).toBe(200);
    expect(reissueAuthJwtOnResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { mfaVerified: true },
    );
    expect(res.headers.get('set-cookie')).toContain('__test-reissued=yes');
  });

  it('recovery code 全件不一致: 400 + cookie 発行しない', async () => {
    vi.mocked(prisma.recoveryCode.findMany).mockResolvedValue([
      { id: 'rc1', codeHash: 'hashed' },
    ] as never);
    vi.mocked(compare).mockResolvedValue(true as never);

    const res = await POST(
      makeReq({ userId: USER_ID, recoveryCode: 'WRONG-CODE' }),
    );
    expect(res.status).toBe(400);
    expect(reissueAuthJwtOnResponse).not.toHaveBeenCalled();
  });

  it('code も recoveryCode も無い body: 400', async () => {
    const res = await POST(makeReq({ userId: USER_ID }));
    expect(res.status).toBe(400);
    expect(reissueAuthJwtOnResponse).not.toHaveBeenCalled();
  });

  it('★ TOTP 検証成功でも reissue 失敗時は 500 + MFA_SESSION_REFRESH_FAILED を返す (永久ループ防止)', async () => {
    vi.mocked(verifyTotp).mockResolvedValue(true);
    vi.mocked(reissueAuthJwtOnResponse).mockResolvedValueOnce({
      ok: false,
      reason: 'decode_failed',
    } as never);
    const res = await POST(makeReq({ userId: USER_ID, code: '123456' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error?.code).toBe('MFA_SESSION_REFRESH_FAILED');
    expect(body.error?.reason).toBe('decode_failed');
  });
});
