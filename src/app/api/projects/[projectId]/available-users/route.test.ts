import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  checkProjectPermission: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findMany: vi.fn() },
  },
}));

import { GET } from './route';
import { NextResponse } from 'next/server';
import { getAuthenticatedUser, checkProjectPermission } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';

const mockedGetAuth = vi.mocked(getAuthenticatedUser);
const mockedCheckPerm = vi.mocked(checkProjectPermission);
const mockedUserFindMany = vi.mocked(prisma.user.findMany);

const VALID_USER = {
  id: '00000000-0000-0000-0000-000000000010',
  tenantId: '00000000-0000-0000-0000-000000000001',
  name: 'Tester',
  email: 't@example.com',
  systemRole: 'general' as const,
};

function mockParams(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetAuth.mockResolvedValue(VALID_USER);
  mockedCheckPerm.mockResolvedValue(null);
  mockedUserFindMany.mockResolvedValue([] as never);
});

describe('GET /api/projects/[projectId]/available-users', () => {
  it('未認証なら 401 を透過', async () => {
    mockedGetAuth.mockResolvedValueOnce(
      NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 }),
    );
    const res = await GET(new Request('http://localhost/x') as never, mockParams('p1'));
    expect(res.status).toBe(401);
    expect(mockedUserFindMany).not.toHaveBeenCalled();
  });

  it('member:manage 権限なしなら 403 を透過', async () => {
    mockedCheckPerm.mockResolvedValueOnce(
      NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }),
    );
    const res = await GET(new Request('http://localhost/x') as never, mockParams('p1'));
    expect(res.status).toBe(403);
    expect(mockedUserFindMany).not.toHaveBeenCalled();
  });

  it('テナント越境防止: where に user.tenantId が必ず付与される (severity-1 防御)', async () => {
    await GET(new Request('http://localhost/x') as never, mockParams('p1'));

    expect(mockedUserFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: VALID_USER.tenantId,
          isActive: true,
          deletedAt: null,
        }),
      }),
    );
  });

  // PR fix/chat-search-and-auto-open (2026-05-24): DoS 防御の take 上限。
  // 旧仕様は無制限 findMany で、member:manage 権限を持つユーザが連投すれば
  // テナント全アクティブユーザ列挙 (10000+ 行スキャン) が走る経路だった。
  it('DoS 防御: findMany に take 上限 (500) が付与される', async () => {
    await GET(new Request('http://localhost/x') as never, mockParams('p1'));

    expect(mockedUserFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 500,
      }),
    );
  });

  it('機微情報 (lockedUntil / MFA 状態 / failedLoginCount) は select に含めない', async () => {
    await GET(new Request('http://localhost/x') as never, mockParams('p1'));

    const callArg = mockedUserFindMany.mock.calls[0]?.[0];
    expect(callArg?.select).toEqual({
      id: true,
      name: true,
      email: true,
      isActive: true,
    });
    // /api/admin/users が扱う機微情報が漏れていないこと
    expect(callArg?.select).not.toHaveProperty('lockedUntil');
    expect(callArg?.select).not.toHaveProperty('mfaEnabled');
    expect(callArg?.select).not.toHaveProperty('failedLoginCount');
  });
});
