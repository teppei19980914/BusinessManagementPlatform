import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findUnique: vi.fn() },
    projectMember: { findFirst: vi.fn() },
  },
}));

import { checkMembership, checkMembershipWithActualRole } from './membership';
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

/**
 * perf/phase-4 (2026-06-01): checkMembership + getActualProjectRole 統合関数の
 * セキュリティ invariant + 内部並列化テスト。
 *
 * デグレ防止のため checkMembership の全テストパターンを actualProjectRole 付きで再検証。
 */
describe('checkMembershipWithActualRole (perf/phase-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Project と ProjectMember を Promise.all で並列実行 (round-trip 1 回に集約)', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      status: 'active',
      deletedAt: null,
      tenantId: 'tenant-A',
    } as never);
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue({
      projectRole: 'member',
    } as never);

    await checkMembershipWithActualRole('p1', 'u1', 'general', 'tenant-A');

    // 両 query が共に呼ばれている (= 並列実行のための前提)
    expect(prisma.project.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.projectMember.findFirst).toHaveBeenCalledTimes(1);
  });

  it('プロジェクトが存在しない場合は isMember=false + actualProjectRole=null', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(null);

    const result = await checkMembershipWithActualRole('p1', 'u1', 'general', 'tenant-A');

    expect(result).toEqual({
      isMember: false,
      projectRole: null,
      projectStatus: null,
      actualProjectRole: null,
    });
  });

  it('テナント越境は admin であっても isMember=false (severity-1 invariant 保持)', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      status: 'active',
      deletedAt: null,
      tenantId: 'tenant-B',
    } as never);
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(null);

    const result = await checkMembershipWithActualRole('p1', 'admin-id', 'admin', 'tenant-A');

    expect(result.isMember).toBe(false);
    expect(result.projectRole).toBe(null);
    expect(result.projectStatus).toBe(null);
  });

  it('admin は自テナント内なら削除済プロジェクトでも projectRole=pm_tl 短絡', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      status: 'active',
      deletedAt: new Date(),
      tenantId: 'tenant-A',
    } as never);
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(null);

    const result = await checkMembershipWithActualRole('p1', 'admin-id', 'admin', 'tenant-A');

    expect(result.isMember).toBe(true);
    expect(result.projectRole).toBe('pm_tl');
    // admin 短絡されても actualProjectRole は実 row ベースで null
    expect(result.actualProjectRole).toBe(null);
  });

  it('admin で実 ProjectMember row があれば actualProjectRole にその値が返る', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      status: 'active',
      deletedAt: null,
      tenantId: 'tenant-A',
    } as never);
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue({
      projectRole: 'pm_tl',
    } as never);

    const result = await checkMembershipWithActualRole('p1', 'admin-id', 'admin', 'tenant-A');

    expect(result.projectRole).toBe('pm_tl'); // admin 短絡値
    expect(result.actualProjectRole).toBe('pm_tl'); // 実 row 値
  });

  it('非 admin で実 ProjectMember row があれば projectRole === actualProjectRole', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      status: 'active',
      deletedAt: null,
      tenantId: 'tenant-A',
    } as never);
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue({
      projectRole: 'member',
    } as never);

    const result = await checkMembershipWithActualRole('p1', 'u1', 'general', 'tenant-A');

    expect(result.isMember).toBe(true);
    expect(result.projectRole).toBe('member');
    expect(result.actualProjectRole).toBe('member');
  });

  it('非 admin で論理削除済みプロジェクトは isMember=false', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      status: 'active',
      deletedAt: new Date(),
      tenantId: 'tenant-A',
    } as never);
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue({
      projectRole: 'member',
    } as never);

    const result = await checkMembershipWithActualRole('p1', 'u1', 'general', 'tenant-A');

    expect(result.isMember).toBe(false);
    expect(result.projectRole).toBe(null);
    // actualProjectRole は実 row ベースで返る (UI 側で「削除済の元メンバー」表示にも使える)
    expect(result.actualProjectRole).toBe('member');
  });

  it('super_admin はテナント越境 bypass (MANAGEMENT_TENANT から全テナント管理)', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      status: 'active',
      deletedAt: null,
      tenantId: 'tenant-B',
    } as never);
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(null);

    const result = await checkMembershipWithActualRole(
      'p1',
      'super-id',
      'super_admin',
      'tenant-MANAGEMENT',
    );

    expect(result.isMember).toBe(true);
    expect(result.projectRole).toBe('pm_tl');
  });
});
