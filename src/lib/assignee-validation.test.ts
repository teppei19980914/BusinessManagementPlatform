import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findFirst: vi.fn(),
    },
  },
}));

import { assertAssigneeTenant } from './assignee-validation';
import { prisma } from '@/lib/db';

describe('assertAssigneeTenant', () => {
  beforeEach(() => vi.clearAllMocks());

  it('assigneeId が undefined なら何もせず resolve', async () => {
    await expect(assertAssigneeTenant(undefined, 'tenant-A')).resolves.toBeUndefined();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('assigneeId が null (担当解除) なら何もせず resolve', async () => {
    await expect(assertAssigneeTenant(null, 'tenant-A')).resolves.toBeUndefined();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('assigneeId が同テナントの active ユーザなら resolve', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ tenantId: 'tenant-A' } as never);
    await expect(assertAssigneeTenant('user-1', 'tenant-A')).resolves.toBeUndefined();
    // 4 巡目検証: findFirst + deletedAt: null フィルタを必ず使う (soft-delete user 除外)
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'user-1', deletedAt: null },
      select: { tenantId: true },
    });
  });

  // severity-1 越境攻撃の防御
  it('assigneeId が他テナントのユーザなら ASSIGNEE_TENANT_MISMATCH を throw', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ tenantId: 'tenant-B' } as never);
    await expect(assertAssigneeTenant('user-other-tenant', 'tenant-A')).rejects.toThrow(
      'ASSIGNEE_TENANT_MISMATCH',
    );
  });

  // 存在しないユーザ id (UUID 形式だが DB に存在しない) も同様に reject
  it('assigneeId が存在しない user なら ASSIGNEE_TENANT_MISMATCH を throw', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    await expect(assertAssigneeTenant('nonexistent', 'tenant-A')).rejects.toThrow(
      'ASSIGNEE_TENANT_MISMATCH',
    );
  });

  // 4 巡目検証 (KDD §5.X+157): soft-delete (deletedAt セット) されたユーザは reject
  it('assigneeId が soft-delete されたユーザなら ASSIGNEE_TENANT_MISMATCH を throw', async () => {
    // findFirst with deletedAt: null where → soft-delete user は null として返る
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    await expect(assertAssigneeTenant('user-deleted', 'tenant-A')).rejects.toThrow(
      'ASSIGNEE_TENANT_MISMATCH',
    );
  });
});
