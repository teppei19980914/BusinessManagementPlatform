import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

/**
 * `redirect()` は Next.js 内部で NEXT_REDIRECT エラーを throw する。テストでは
 * 識別可能な独自エラーに置き換えて、呼び出し有無 + 渡された URL を検証する。
 */
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    const err = new Error(`__REDIRECT__:${url}`);
    (err as Error & { __redirect?: string }).__redirect = url;
    throw err;
  }),
}));

import { requireAuthForLayout } from './page-auth';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { redirect } from 'next/navigation';
import { LOGIN_ROUTE } from '@/config';

const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001';

const baseSessionUser = {
  id: 'user-1',
  tenantId: TEST_TENANT_ID,
  name: 'Alice',
  email: 'alice@example.com',
  systemRole: 'general',
  forcePasswordChange: false,
  mfaEnabled: false,
  mfaVerified: true,
  themePreference: 'light',
  timezone: 'Asia/Tokyo',
  locale: 'ja-JP',
  tenantPlan: 'pro',
  tenantCreatedAt: '2026-01-01T00:00:00.000Z',
  tenantBeginnerEverUpgraded: false,
  tenantStorageGracePeriodStartedAt: null,
  tenantSuspendedAt: null,
  tokenVersion: 0,
};

describe('requireAuthForLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('セッションが無ければ LOGIN_ROUTE に redirect する', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    await expect(requireAuthForLayout()).rejects.toThrow(`__REDIRECT__:${LOGIN_ROUTE}`);
    expect(redirect).toHaveBeenCalledWith(LOGIN_ROUTE);
    // tokenVersion 検証まで進まないことを確認 (= 余計な DB query が走らない)
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('JWT tokenVersion が DB と不一致なら LOGIN_ROUTE に redirect する (★ explicit-signout 経路で increment されたケース)', async () => {
    vi.mocked(auth).mockResolvedValue({ user: { ...baseSessionUser, tokenVersion: 0 } } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      tokenVersion: 1, // DB 側は logout 経由で increment 済
      isActive: true,
      deletedAt: null,
    } as never);

    await expect(requireAuthForLayout()).rejects.toThrow(`__REDIRECT__:${LOGIN_ROUTE}`);
    expect(redirect).toHaveBeenCalledWith(LOGIN_ROUTE);
  });

  it('対象ユーザが削除済 (deletedAt != null) なら LOGIN_ROUTE に redirect する', async () => {
    vi.mocked(auth).mockResolvedValue({ user: baseSessionUser } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      tokenVersion: 0,
      isActive: true,
      deletedAt: new Date(),
    } as never);

    await expect(requireAuthForLayout()).rejects.toThrow(`__REDIRECT__:${LOGIN_ROUTE}`);
    expect(redirect).toHaveBeenCalledWith(LOGIN_ROUTE);
  });

  it('対象ユーザが無効化済 (isActive=false) なら LOGIN_ROUTE に redirect する', async () => {
    vi.mocked(auth).mockResolvedValue({ user: baseSessionUser } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      tokenVersion: 0,
      isActive: false,
      deletedAt: null,
    } as never);

    await expect(requireAuthForLayout()).rejects.toThrow(`__REDIRECT__:${LOGIN_ROUTE}`);
    expect(redirect).toHaveBeenCalledWith(LOGIN_ROUTE);
  });

  it('全て OK なら session.user 全体を返す (dashboard-header の user object 互換性のため)', async () => {
    vi.mocked(auth).mockResolvedValue({ user: baseSessionUser } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      tokenVersion: 0,
      isActive: true,
      deletedAt: null,
    } as never);

    const result = await requireAuthForLayout();

    expect(result).toEqual(baseSessionUser);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('DB にユーザが見つからない (= 削除直後) なら LOGIN_ROUTE に redirect する', async () => {
    vi.mocked(auth).mockResolvedValue({ user: baseSessionUser } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);

    await expect(requireAuthForLayout()).rejects.toThrow(`__REDIRECT__:${LOGIN_ROUTE}`);
    expect(redirect).toHaveBeenCalledWith(LOGIN_ROUTE);
  });
});
