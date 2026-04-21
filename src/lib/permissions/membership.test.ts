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

    const result = await checkMembership('p1', 'u1', 'general');

    expect(result).toEqual({ isMember: false, projectRole: null, projectStatus: null });
  });

  it('システム管理者は削除済みプロジェクトでも pm_tl としてアクセス可', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      status: 'active',
      deletedAt: new Date(),
    } as never);

    const result = await checkMembership('p1', 'admin-id', 'admin');

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
    } as never);

    const result = await checkMembership('p1', 'u1', 'general');

    expect(result.isMember).toBe(false);
    expect(result.projectRole).toBe(null);
    expect(result.projectStatus).toBe('active');
  });

  it('非管理者かつメンバーでない場合は isMember: false', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      status: 'active',
      deletedAt: null,
    } as never);
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(null);

    const result = await checkMembership('p1', 'u1', 'general');

    expect(result.isMember).toBe(false);
    expect(result.projectRole).toBe(null);
    expect(result.projectStatus).toBe('active');
  });

  it('非管理者がメンバーなら projectRole を返す', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      status: 'active',
      deletedAt: null,
    } as never);
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue({
      projectRole: 'pm_tl',
    } as never);

    const result = await checkMembership('p1', 'u1', 'general');

    expect(result).toEqual({
      isMember: true,
      projectRole: 'pm_tl',
      projectStatus: 'active',
    });
  });
});
