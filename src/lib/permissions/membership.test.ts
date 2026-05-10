import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findUnique: vi.fn() },
    projectMember: { findFirst: vi.fn() },
  },
}));

import { checkMembership } from './membership';
import { prisma } from '@/lib/db';

describe('checkMembership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('プロジェクトが存在しない場合は isMember: false', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue(null);

    const result = await checkMembership('p1', 'u1', 'general', 'tenant-A');

    expect(result).toEqual({ isMember: false, projectRole: null, projectStatus: null });
  });

  it('システム管理者は (自テナント内の) 削除済みプロジェクトでも pm_tl としてアクセス可', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      status: 'active',
      deletedAt: new Date(),
      tenantId: 'tenant-A',
    } as never);

    const result = await checkMembership('p1', 'admin-id', 'admin', 'tenant-A');

    expect(result.isMember).toBe(true);
    expect(result.projectRole).toBe('pm_tl');
    expect(result.projectStatus).toBe('active');
    // admin は project member テーブルを参照しない (早期 return)
    expect(prisma.projectMember.findFirst).not.toHaveBeenCalled();
  });

  it('非管理者は削除済みプロジェクトにアクセス不可', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      status: 'active',
      deletedAt: new Date(),
      tenantId: 'tenant-A',
    } as never);

    const result = await checkMembership('p1', 'u1', 'general', 'tenant-A');

    expect(result.isMember).toBe(false);
    expect(result.projectRole).toBe(null);
    expect(result.projectStatus).toBe('active');
  });

  it('非管理者かつメンバーでない場合は isMember: false', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      status: 'active',
      deletedAt: null,
      tenantId: 'tenant-A',
    } as never);
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(null);

    const result = await checkMembership('p1', 'u1', 'general', 'tenant-A');

    expect(result.isMember).toBe(false);
    expect(result.projectRole).toBe(null);
    expect(result.projectStatus).toBe('active');
  });

  it('非管理者がメンバーなら projectRole を返す', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      status: 'active',
      deletedAt: null,
      tenantId: 'tenant-A',
    } as never);
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue({
      projectRole: 'pm_tl',
    } as never);

    const result = await checkMembership('p1', 'u1', 'general', 'tenant-A');

    expect(result).toEqual({
      isMember: true,
      projectRole: 'pm_tl',
      projectStatus: 'active',
    });
  });

  // 2026-05-09 feedback: severity-1 テナント越境バグ恒久対策の核心テスト群
  describe('テナント越境防止 (severity-1)', () => {
    it('admin であってもテナントが異なる project にはアクセス不可 (404 相当)', async () => {
      vi.mocked(prisma.project.findUnique).mockResolvedValue({
        status: 'active',
        deletedAt: null,
        tenantId: 'tenant-B', // 他テナント所属
      } as never);

      const result = await checkMembership('p1', 'admin-id', 'admin', 'tenant-A');

      expect(result.isMember).toBe(false);
      expect(result.projectRole).toBe(null);
      expect(result.projectStatus).toBe(null);
      // テナント越境のため projectMember は参照しない (早期 return)
      expect(prisma.projectMember.findFirst).not.toHaveBeenCalled();
    });

    it('一般ユーザもテナント越境の project にはアクセス不可', async () => {
      vi.mocked(prisma.project.findUnique).mockResolvedValue({
        status: 'active',
        deletedAt: null,
        tenantId: 'tenant-B',
      } as never);

      const result = await checkMembership('p1', 'u1', 'general', 'tenant-A');

      expect(result.isMember).toBe(false);
      expect(prisma.projectMember.findFirst).not.toHaveBeenCalled();
    });

    it('super_admin は MANAGEMENT_TENANT 所属で全テナント横断管理可 (越境チェック bypass)', async () => {
      vi.mocked(prisma.project.findUnique).mockResolvedValue({
        status: 'active',
        deletedAt: null,
        tenantId: 'tenant-B', // super_admin の tenantId と異なっても OK
      } as never);

      const result = await checkMembership('p1', 'super-id', 'super_admin', 'tenant-MANAGEMENT');

      expect(result.isMember).toBe(true);
      expect(result.projectRole).toBe('pm_tl');
    });
  });
});
