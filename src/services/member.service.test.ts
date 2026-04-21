import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findFirst: vi.fn() },
    projectMember: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    roleChangeLog: { create: vi.fn() },
  },
}));

import { listMembers, addMember, updateMemberRole, removeMember } from './member.service';
import { prisma } from '@/lib/db';

const now = new Date('2026-04-21T10:00:00Z');
const mRow = (o: Record<string, unknown> = {}) => ({
  id: 'm-1',
  userId: 'u-1',
  projectId: 'p-1',
  projectRole: 'member',
  createdAt: now,
  user: { name: 'Alice', email: 'a@b.co' },
  ...o,
});

describe('listMembers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('プロジェクトメンバー一覧を DTO に変換して返す', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([mRow()] as never);

    const r = await listMembers('p-1');

    expect(r).toHaveLength(1);
    expect(r[0].userName).toBe('Alice');
    expect(r[0].userEmail).toBe('a@b.co');
    expect(prisma.projectMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: 'p-1' } }),
    );
  });
});

describe('addMember', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ユーザが存在しなければ USER_NOT_FOUND', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

    await expect(addMember('p-1', 'u-1', 'member', 'admin-1')).rejects.toThrow('USER_NOT_FOUND');
    expect(prisma.projectMember.create).not.toHaveBeenCalled();
  });

  it('既にメンバーなら ALREADY_MEMBER', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'u-1' } as never);
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue({ id: 'existing' } as never);

    await expect(addMember('p-1', 'u-1', 'member', 'admin-1')).rejects.toThrow('ALREADY_MEMBER');
  });

  it('成功: メンバー作成 + roleChangeLog に記録', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'u-1' } as never);
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.projectMember.create).mockResolvedValue(mRow() as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    const r = await addMember('p-1', 'u-1', 'member', 'admin-1');

    expect(r.userId).toBe('u-1');
    expect(prisma.roleChangeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          changeType: 'project_role',
          afterRole: 'member',
          projectId: 'p-1',
        }),
      }),
    );
  });
});

describe('updateMemberRole', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在しなければ NOT_FOUND', async () => {
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue(null);
    await expect(updateMemberRole('x', 'pm_tl', 'admin-1')).rejects.toThrow('NOT_FOUND');
  });

  it('ロール変更 + beforeRole/afterRole を記録', async () => {
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue(
      mRow({ projectRole: 'member' }) as never,
    );
    vi.mocked(prisma.projectMember.update).mockResolvedValue(
      mRow({ projectRole: 'pm_tl' }) as never,
    );
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    const r = await updateMemberRole('m-1', 'pm_tl', 'admin-1');

    expect(r.projectRole).toBe('pm_tl');
    expect(prisma.roleChangeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ beforeRole: 'member', afterRole: 'pm_tl' }),
      }),
    );
  });
});

describe('removeMember', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在しなければ NOT_FOUND', async () => {
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue(null);
    await expect(removeMember('x', 'admin-1')).rejects.toThrow('NOT_FOUND');
    expect(prisma.projectMember.delete).not.toHaveBeenCalled();
  });

  it('物理削除 + removed ログ', async () => {
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue(mRow() as never);
    vi.mocked(prisma.projectMember.delete).mockResolvedValue({} as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    await removeMember('m-1', 'admin-1');

    expect(prisma.projectMember.delete).toHaveBeenCalledWith({ where: { id: 'm-1' } });
    expect(prisma.roleChangeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ afterRole: 'removed' }),
      }),
    );
  });
});
