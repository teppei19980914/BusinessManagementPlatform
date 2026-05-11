import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    projectMember: {
      findMany: vi.fn(),
    },
  },
}));

import { resolveGuideRole } from './guide-role.service';
import { prisma } from '@/lib/db';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveGuideRole', () => {
  it('systemRole=admin は ProjectMember を見ずに admin を返す', async () => {
    const r = await resolveGuideRole('u1', 'admin');
    expect(r).toBe('admin');
    expect(prisma.projectMember.findMany).not.toHaveBeenCalled();
  });

  it('systemRole=super_admin も admin を返す', async () => {
    const r = await resolveGuideRole('u1', 'super_admin');
    expect(r).toBe('admin');
  });

  it('general + ProjectMember 0 件 → member (新規ユーザのデフォルト)', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValueOnce([] as never);
    const r = await resolveGuideRole('u1', 'general');
    expect(r).toBe('member');
  });

  it('general + projectRole=pm_tl が 1 つでもあれば pm (最上位採用)', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValueOnce([
      { projectRole: 'member' },
      { projectRole: 'pm_tl' }, // 別プロジェクトで PM/PL
      { projectRole: 'viewer' },
    ] as never);
    const r = await resolveGuideRole('u1', 'general');
    expect(r).toBe('pm');
  });

  it('general + projectRole=member のみなら member', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValueOnce([
      { projectRole: 'member' },
      { projectRole: 'member' },
    ] as never);
    const r = await resolveGuideRole('u1', 'general');
    expect(r).toBe('member');
  });

  it('general + projectRole=member + viewer の混在なら member 優先', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValueOnce([
      { projectRole: 'viewer' },
      { projectRole: 'member' },
    ] as never);
    const r = await resolveGuideRole('u1', 'general');
    expect(r).toBe('member');
  });

  it('general + projectRole=viewer のみなら viewer', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValueOnce([
      { projectRole: 'viewer' },
      { projectRole: 'viewer' },
    ] as never);
    const r = await resolveGuideRole('u1', 'general');
    expect(r).toBe('viewer');
  });

  it('削除済 project のメンバーシップは無視される (where 条件で除外)', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValueOnce([] as never);

    await resolveGuideRole('u1', 'general');

    const where = vi.mocked(prisma.projectMember.findMany).mock.calls[0]![0]!.where!;
    expect(where).toMatchObject({
      userId: 'u1',
      project: { deletedAt: null },
    });
  });

  it('未知の projectRole 値 (DB 不整合) は安全側に member を返す', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValueOnce([
      { projectRole: 'unknown_role_value' },
    ] as never);
    const r = await resolveGuideRole('u1', 'general');
    expect(r).toBe('member');
  });
});
