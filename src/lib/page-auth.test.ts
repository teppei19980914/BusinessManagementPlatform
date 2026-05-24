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

import { requireAuthForLayout, optionalAuthForLayout } from './page-auth';
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

/**
 * optionalAuthForLayout (KDD §5.X+121 / feat/app-header-footer-unification 2026-05-24)
 *
 * (public) layout 専用。未認証でも redirect せず null を返すが、tokenVersion 検証は
 * requireAuthForLayout と同水準で行い、失効済 cookie を「ログイン状態」扱いしない。
 */
describe('optionalAuthForLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('セッションが無ければ null を返す (redirect しない、DB クエリも走らない)', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const result = await optionalAuthForLayout();

    expect(result).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('tokenVersion が DB と不一致なら null を返す (★ 失効済 cookie を「ログイン状態」扱いしない)', async () => {
    // この検証が抜けると Netlify Set-Cookie 脱落 (KDD §5.X+72) で他人なりすまし経路が
    // public layout 側で復活してしまう (severity-1 個人情報漏洩)。
    vi.mocked(auth).mockResolvedValue({ user: { ...baseSessionUser, tokenVersion: 0 } } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      tokenVersion: 1,
      isActive: true,
      deletedAt: null,
    } as never);

    const result = await optionalAuthForLayout();

    expect(result).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('対象ユーザが削除済 (deletedAt != null) なら null を返す', async () => {
    vi.mocked(auth).mockResolvedValue({ user: baseSessionUser } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      tokenVersion: 0,
      isActive: true,
      deletedAt: new Date(),
    } as never);

    const result = await optionalAuthForLayout();

    expect(result).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('対象ユーザが無効化済 (isActive=false) なら null を返す', async () => {
    vi.mocked(auth).mockResolvedValue({ user: baseSessionUser } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      tokenVersion: 0,
      isActive: false,
      deletedAt: null,
    } as never);

    const result = await optionalAuthForLayout();

    expect(result).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('全て OK なら session.user 全体を返す (AppHeader にそのまま渡せる形)', async () => {
    vi.mocked(auth).mockResolvedValue({ user: baseSessionUser } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      tokenVersion: 0,
      isActive: true,
      deletedAt: null,
    } as never);

    const result = await optionalAuthForLayout();

    expect(result).toEqual(baseSessionUser);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('DB にユーザが見つからない (= 削除直後) なら null を返す', async () => {
    vi.mocked(auth).mockResolvedValue({ user: baseSessionUser } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);

    const result = await optionalAuthForLayout();

    expect(result).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });
});
