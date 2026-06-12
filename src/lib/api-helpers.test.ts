import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/permissions', () => ({
  checkPermission: vi.fn(),
  checkMembership: vi.fn(),
}));

// 2026-05-13 (security/jwt-invalidation, L-1): getAuthenticatedUser は DB 検証を行うため mock 必須
vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    projectMember: {
      findFirst: vi.fn(),
    },
    project: {
      findFirst: vi.fn(),
    },
  },
}));

import {
  getAuthenticatedUser,
  checkProjectPermission,
  requireAdmin,
  requireProjectNotClosed,
} from './api-helpers';
import { auth } from '@/lib/auth';
import { checkPermission, checkMembership } from '@/lib/permissions';
import { prisma } from '@/lib/db';
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

  it('セッションがあり DB の tokenVersion が JWT と一致すればユーザ情報を返す', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: {
        id: 'user-1',
        tenantId: TEST_TENANT_ID,
        name: 'Alice',
        email: 'alice@example.com',
        systemRole: 'general',
        tokenVersion: 0,
      },
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      tokenVersion: 0,
      isActive: true,
      deletedAt: null,
    } as never);

    const result = await getAuthenticatedUser();

    expect(result).toEqual({
      id: 'user-1',
      tenantId: TEST_TENANT_ID,
      name: 'Alice',
      email: 'alice@example.com',
      systemRole: 'general',
    });
  });

  // 2026-05-13 (security/jwt-invalidation, L-1): JWT 失効ガードの回帰テスト
  it('JWT tokenVersion が DB と不一致なら 401 SESSION_INVALIDATED (L-1: admin 強制ログアウト経路)', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: {
        id: 'user-1',
        tenantId: TEST_TENANT_ID,
        name: 'Alice',
        email: 'alice@example.com',
        systemRole: 'general',
        tokenVersion: 0, // JWT 側は 0
      },
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      tokenVersion: 1, // DB 側は 1 (admin が increment 済)
      isActive: true,
      deletedAt: null,
    } as never);

    const result = await getAuthenticatedUser();

    expect(result).toBeInstanceOf(Response);
    const body = await (result as Response).json();
    expect(body.error.code).toBe('SESSION_INVALIDATED');
    expect((result as Response).status).toBe(401);
  });

  it('対象ユーザが削除済 (deletedAt != null) なら 401', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: {
        id: 'user-1',
        tenantId: TEST_TENANT_ID,
        name: 'Alice',
        email: 'alice@example.com',
        systemRole: 'general',
        tokenVersion: 0,
      },
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      tokenVersion: 0,
      isActive: true,
      deletedAt: new Date(),
    } as never);

    const result = await getAuthenticatedUser();

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it('対象ユーザが無効化 (isActive=false) なら 401', async () => {
    vi.mocked(auth).mockResolvedValue({
      user: {
        id: 'user-1',
        tenantId: TEST_TENANT_ID,
        name: 'Alice',
        email: 'alice@example.com',
        systemRole: 'general',
        tokenVersion: 0,
      },
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      tokenVersion: 0,
      isActive: false,
      deletedAt: null,
    } as never);

    const result = await getAuthenticatedUser();

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
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
    } as never);

    const res = await checkProjectPermission(generalUser, 'p1', 'edit_task' as never);

    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(404);
  });

  it('checkPermission が不許可なら 403', async () => {
    vi.mocked(checkMembership).mockResolvedValue({
      isMember: true,
      projectRole: 'member',
      projectStatus: 'active',
    } as never);
    vi.mocked(checkPermission).mockReturnValue({ allowed: false, reason: 'ロール不足' });

    const res = await checkProjectPermission(generalUser, 'p1', 'edit_task' as never);

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
    } as never);
    vi.mocked(checkPermission).mockReturnValue({ allowed: true });

    const res = await checkProjectPermission(generalUser, 'p1', 'edit_task' as never);

    expect(res).toBe(null);
  });

  it('resourceOwnerId を context へ渡す', async () => {
    vi.mocked(checkMembership).mockResolvedValue({
      isMember: true,
      projectRole: 'member',
      projectStatus: 'active',
    } as never);
    vi.mocked(checkPermission).mockReturnValue({ allowed: true });

    await checkProjectPermission(generalUser, 'p1', 'edit_task' as never, 'owner-xyz');

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

  // 2026-05-13 (security/auth-secret-hardening, B-3): super_admin が requireAdmin を通る事を保証する。
  //   旧実装は `user.systemRole !== 'admin'` で super_admin を 403 で弾いており、
  //   /api/admin/users/** など 18 ファイルで super_admin が業務不能だった (運用バグ)。
  //   isAdminOrAbove ヘルパに置換し、admin と super_admin を等しく許可する。
  it('super_admin なら null (B-3: 旧実装で 403 だった運用バグの回帰テスト)', () => {
    const superAdminUser = {
      id: 'super-1',
      tenantId: TEST_TENANT_ID,
      name: 'Super',
      email: 'super@example.com',
      systemRole: 'super_admin' as SystemRole,
    };
    expect(requireAdmin(superAdminUser)).toBe(null);
  });
});

// 2026-06-12: クローズ済みプロジェクト (status='closed') の write を弾く共通ガード。
//   read アクションで認可している write route (リスク削除 / 振り返り更新・削除) の
//   クローズ制約漏れを塞ぐためのヘルパ。
describe('requireProjectNotClosed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('クローズ済み (status=closed) なら 403 PROJECT_CLOSED', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ status: 'closed' } as never);
    const res = await requireProjectNotClosed('p1', TEST_TENANT_ID);
    expect(res).toBeInstanceOf(Response);
    const body = await (res as Response).json();
    expect(body.error.code).toBe('PROJECT_CLOSED');
    expect((res as Response).status).toBe(403);
  });

  it('open なプロジェクト (status=active) は null (許可)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ status: 'active' } as never);
    const res = await requireProjectNotClosed('p1', TEST_TENANT_ID);
    expect(res).toBe(null);
  });

  it('プロジェクト未存在 (越境/削除済) は null を返し、存在チェックは呼出側に委ねる', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null as never);
    const res = await requireProjectNotClosed('p1', TEST_TENANT_ID);
    expect(res).toBe(null);
  });

  it('越境遮断: where に tenantId を併記してクエリする', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ status: 'planning' } as never);
    await requireProjectNotClosed('p1', TEST_TENANT_ID);
    const call = vi.mocked(prisma.project.findFirst).mock.calls[0]![0] as {
      where: { id: string; tenantId: string };
    };
    expect(call.where.id).toBe('p1');
    expect(call.where.tenantId).toBe(TEST_TENANT_ID);
  });
});
