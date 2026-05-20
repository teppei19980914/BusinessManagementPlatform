import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findFirst: vi.fn() },
    // 2026-05-09 feedback Phase 2-6: addMember で project tenant 検証用
    project: { findFirst: vi.fn() },
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

    const r = await listMembers('p-1', 'tenant-A');

    expect(r).toHaveLength(1);
    expect(r[0].userName).toBe('Alice');
    expect(r[0].userEmail).toBe('a@b.co');
    expect(prisma.projectMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: 'p-1', project: { tenantId: 'tenant-A' } } }),
    );
  });
});

describe('addMember', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ユーザが存在しなければ USER_NOT_FOUND', async () => {
    // 2026-05-09 feedback Phase 2-6: project tenant 検証 mock 必須
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'p-1' } as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

    await expect(addMember('p-1', 'u-1', 'member', 'admin-1', 'tenant-A', 'admin')).rejects.toThrow('USER_NOT_FOUND');
    expect(prisma.projectMember.create).not.toHaveBeenCalled();
  });

  it('既にメンバーなら ALREADY_MEMBER', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'p-1' } as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'u-1' } as never);
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue({ id: 'existing' } as never);

    await expect(addMember('p-1', 'u-1', 'member', 'admin-1', 'tenant-A', 'admin')).rejects.toThrow('ALREADY_MEMBER');
  });

  it('成功: メンバー作成 + roleChangeLog に記録', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'p-1' } as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'u-1' } as never);
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.projectMember.create).mockResolvedValue(mRow() as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    const r = await addMember('p-1', 'u-1', 'member', 'admin-1', 'tenant-A', 'admin');

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

  // feat/crud-permission-redesign (2026-05-20): pm_tl ロール扱いの細粒度ガード
  it('PM/TL ロールの追加を一般ユーザ (general systemRole) が実行 → FORBIDDEN_PMTL_ROLE', async () => {
    // 注: API route 側で member:manage を許可された後にサービス層へ到達する想定。
    //   actorSystemRole='general' は API route が pm_tl の projectRole で通過させた場合
    //   (service 層の最終防衛線)。
    await expect(
      addMember('p-1', 'u-1', 'pm_tl', 'actor-pm', 'tenant-A', 'general'),
    ).rejects.toThrow('FORBIDDEN_PMTL_ROLE');
    expect(prisma.projectMember.create).not.toHaveBeenCalled();
  });

  it('PM/TL ロールの追加を admin が実行 → 成功', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'p-1' } as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'u-1' } as never);
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.projectMember.create).mockResolvedValue(
      mRow({ projectRole: 'pm_tl' }) as never,
    );
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    const r = await addMember('p-1', 'u-1', 'pm_tl', 'admin-1', 'tenant-A', 'admin');
    expect(r.projectRole).toBe('pm_tl');
  });

  it('member 追加は PM/TL アクター (general systemRole + pm_tl 経路) でも成功', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'p-1' } as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'u-1' } as never);
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.projectMember.create).mockResolvedValue(mRow() as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    const r = await addMember('p-1', 'u-1', 'member', 'pm-actor', 'tenant-A', 'general');
    expect(r.projectRole).toBe('member');
  });
});

describe('updateMemberRole', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在しなければ NOT_FOUND', async () => {
    // 2026-05-09 feedback Phase 2-6: findUnique → findFirst (project tenant 検証付き) に変更
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(null);
    await expect(updateMemberRole('x', 'pm_tl', 'admin-1', 'tenant-A', 'admin')).rejects.toThrow('NOT_FOUND');
  });

  it('ロール変更 + beforeRole/afterRole を記録', async () => {
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(
      mRow({ projectRole: 'member' }) as never,
    );
    vi.mocked(prisma.projectMember.update).mockResolvedValue(
      mRow({ projectRole: 'pm_tl' }) as never,
    );
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    const r = await updateMemberRole('m-1', 'pm_tl', 'admin-1', 'tenant-A', 'admin');

    expect(r.projectRole).toBe('pm_tl');
    expect(prisma.roleChangeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ beforeRole: 'member', afterRole: 'pm_tl' }),
      }),
    );
  });

  // feat/crud-permission-redesign (2026-05-20): pm_tl ロール扱いの細粒度ガード
  it('PM/TL への昇格を一般ユーザ (general systemRole) が実行 → FORBIDDEN_PMTL_ROLE', async () => {
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(
      mRow({ projectRole: 'member' }) as never,
    );
    await expect(
      updateMemberRole('m-1', 'pm_tl', 'actor-pm', 'tenant-A', 'general'),
    ).rejects.toThrow('FORBIDDEN_PMTL_ROLE');
    expect(prisma.projectMember.update).not.toHaveBeenCalled();
  });

  it('PM/TL からの降格を一般ユーザ (general systemRole) が実行 → FORBIDDEN_PMTL_ROLE', async () => {
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(
      mRow({ projectRole: 'pm_tl' }) as never,
    );
    await expect(
      updateMemberRole('m-1', 'member', 'actor-pm', 'tenant-A', 'general'),
    ).rejects.toThrow('FORBIDDEN_PMTL_ROLE');
    expect(prisma.projectMember.update).not.toHaveBeenCalled();
  });

  // feat/crud-permission-redesign (2026-05-20 追加要件): 自分自身のプロジェクトロール変更禁止
  it('自分自身のプロジェクトロール変更は CANNOT_CHANGE_OWN_PROJECT_ROLE', async () => {
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(
      // userId と changedBy が同じ = 自己編集
      mRow({ userId: 'self-user', projectRole: 'member' }) as never,
    );
    await expect(
      updateMemberRole('m-1', 'viewer', 'self-user', 'tenant-A', 'admin'),
    ).rejects.toThrow('CANNOT_CHANGE_OWN_PROJECT_ROLE');
    expect(prisma.projectMember.update).not.toHaveBeenCalled();
  });

  it('member ↔ viewer のロール変更は PM/TL アクター (general systemRole) でも成功', async () => {
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(
      mRow({ projectRole: 'member' }) as never,
    );
    vi.mocked(prisma.projectMember.update).mockResolvedValue(
      mRow({ projectRole: 'viewer' }) as never,
    );
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    const r = await updateMemberRole('m-1', 'viewer', 'pm-actor', 'tenant-A', 'general');
    expect(r.projectRole).toBe('viewer');
  });
});

describe('removeMember', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在しなければ NOT_FOUND', async () => {
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(null);
    await expect(removeMember('x', 'admin-1', 'tenant-A', 'admin')).rejects.toThrow('NOT_FOUND');
    expect(prisma.projectMember.delete).not.toHaveBeenCalled();
  });

  // feat/crud-permission-redesign (2026-05-20): PM/TL 削除は admin only
  it('PM/TL の削除を一般ユーザ (general systemRole) が実行 → FORBIDDEN_PMTL_ROLE', async () => {
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(
      mRow({ projectRole: 'pm_tl' }) as never,
    );
    await expect(
      removeMember('m-1', 'actor-pm', 'tenant-A', 'general'),
    ).rejects.toThrow('FORBIDDEN_PMTL_ROLE');
    expect(prisma.projectMember.delete).not.toHaveBeenCalled();
  });

  it('member/viewer の削除は PM/TL アクター (general systemRole) でも成功', async () => {
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(
      mRow({ projectRole: 'member' }) as never,
    );
    vi.mocked(prisma.projectMember.delete).mockResolvedValue({} as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    await removeMember('m-1', 'pm-actor', 'tenant-A', 'general');
    expect(prisma.projectMember.delete).toHaveBeenCalled();
  });

  it('物理削除 + removed ログ', async () => {
    vi.mocked(prisma.projectMember.findFirst).mockResolvedValue(mRow() as never);
    vi.mocked(prisma.projectMember.delete).mockResolvedValue({} as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    await removeMember('m-1', 'admin-1', 'tenant-A', 'admin');

    expect(prisma.projectMember.delete).toHaveBeenCalledWith({ where: { id: 'm-1' } });
    expect(prisma.roleChangeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ afterRole: 'removed' }),
      }),
    );
  });
});
