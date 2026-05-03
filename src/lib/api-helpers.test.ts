import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/permissions', () => ({
  checkPermission: vi.fn(),
  checkMembership: vi.fn(),
}));

import { getAuthenticatedUser, checkProjectPermission, requireAdmin } from './api-helpers';
import { auth } from '@/lib/auth';
import { checkPermission, checkMembership } from '@/lib/permissions';
import type { SystemRole } from '@/types';

const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const adminUser = {
  id: 'admin-1',
  tenantId: TEST_TENANT_ID,
  name: 'Admin',
  email: 'admin@example.com',
  systemRole: 'admin' as SystemRole,
};
const generalUser = {
  id: 'user-1',
  tenantId: TEST_TENANT_ID,
  name: 'User',
  email: 'user@example.com',
  systemRole: 'general' as SystemRole,
};

describe('getAuthenticatedUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('セッションが無ければ 401 レスポンスを返す', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const result = await getAuthenticatedUser();

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('セッションがあればユーザ情報を返す', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: {
        id: 'user-1',
        name: 'Alice',
        email: 'alice@example.com',
        systemRole: 'general',
      },
    } as never);

    const result = await getAuthenticatedUser();

    expect(result).toEqual({
      id: 'user-1',
      name: 'Alice',
      email: 'alice@example.com',
      systemRole: 'general',
    });
  });
});

describe('checkProjectPermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('メンバーでなければ 404 を返す (存在漏洩防止)', async () => {
    vi.mocked(checkMembership).mockResolvedValue({
      isMember: false,
      projectRole: null,
      projectStatus: null,
    });

    const res = await checkProjectPermission(generalUser, 'p1', 'edit_task');

    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(404);
  });

  it('checkPermission が不許可なら 403', async () => {
    vi.mocked(checkMembership).mockResolvedValue({
      isMember: true,
      projectRole: 'member',
      projectStatus: 'active',
    });
    vi.mocked(checkPermission).mockReturnValue({ allowed: false, reason: 'ロール不足' });

    const res = await checkProjectPermission(generalUser, 'p1', 'edit_task');

    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
    const body = await (res as Response).json();
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toBe('ロール不足');
  });

  it('checkPermission が許可なら null を返す', async () => {
    vi.mocked(checkMembership).mockResolvedValue({
      isMember: true,
      projectRole: 'pm_tl',
      projectStatus: 'active',
    });
    vi.mocked(checkPermission).mockReturnValue({ allowed: true });

    const res = await checkProjectPermission(generalUser, 'p1', 'edit_task');

    expect(res).toBe(null);
  });

  it('resourceOwnerId を context へ渡す', async () => {
    vi.mocked(checkMembership).mockResolvedValue({
      isMember: true,
      projectRole: 'member',
      projectStatus: 'active',
    });
    vi.mocked(checkPermission).mockReturnValue({ allowed: true });

    await checkProjectPermission(generalUser, 'p1', 'edit_task', 'owner-xyz');

    expect(checkPermission).toHaveBeenCalledWith(
      'edit_task',
      expect.objectContaining({ resourceOwnerId: 'owner-xyz' }),
    );
  });
});

describe('requireAdmin', () => {
  it('admin なら null', () => {
    expect(requireAdmin(adminUser)).toBe(null);
  });

  it('非 admin なら 403 レスポンス', async () => {
    const res = requireAdmin(generalUser);
    expect(res).toBeInstanceOf(Response);
    const body = await (res as Response).json();
    expect(body.error.code).toBe('FORBIDDEN');
    expect((res as Response).status).toBe(403);
  });
});
