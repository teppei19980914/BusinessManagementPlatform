/**
 * /api/auth/delete-account の route テスト (feat/crud-permission-redesign, 2026-05-20, 2 巡目検証 Test-G4)
 *
 * 目的:
 *   PR #416 S1-D1 で追加した `$transaction` ラップ + S2-A2 で追加した `beforeValue` 記録の
 *   回帰防止 + S2-D5/D1 で集約された「ユーザ自己削除 → membership 解除履歴」フローを検証。
 *
 * scope:
 *   - 入力 validation (password / recoveryCode 必須)
 *   - パスワード再認証 (wrongPassword で 400)
 *   - recoveryCode 検証 (wrongRecoveryCode で 400)
 *   - 論理削除 → membership 取得 → roleChangeLog.createMany → projectMember.deleteMany →
 *     session.deleteMany が transaction 内で実行される
 *   - audit_logs に beforeValue (本人 user 情報) と afterValue ({ action: 'self_delete' }) が記録
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => {
  const prismaMock = {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    recoveryCode: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    projectMember: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    roleChangeLog: {
      createMany: vi.fn(),
    },
    session: {
      deleteMany: vi.fn(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: vi.fn(async (cb: any) => cb(prismaMock)),
  };
  return { prisma: prismaMock };
});

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('bcryptjs', () => ({
  compare: vi.fn(),
}));

vi.mock('@/services/auth-event.service', () => ({
  recordAuthEvent: vi.fn(),
}));

vi.mock('@/services/audit.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/audit.service')>();
  return {
    ...actual,
    recordAuditLog: vi.fn(),
  };
});

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (k: string) => k),
}));

import { POST } from './route';
import { prisma } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { compare } from 'bcryptjs';
import { recordAuditLog } from '@/services/audit.service';

const buildRequest = (body: unknown) =>
  new Request('http://localhost/api/auth/delete-account', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });

const baseUser = {
  id: 'u-self',
  email: 'self@example.com',
  name: '自己ユーザ',
  systemRole: 'general',
  tenantId: 'tenant-A',
} as never;

const baseDbUser = {
  id: 'u-self',
  passwordHash: 'hashed-pw',
  isActive: true,
  deletedAt: null,
  tokenVersion: 0,
} as never;

describe('POST /api/auth/delete-account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthenticatedUser).mockResolvedValue(baseUser);
  });

  it('入力 validation: password 欠落 → 400', async () => {
    const res = await POST(buildRequest({ recoveryCode: 'abc' }) as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('VALIDATION_ERROR');
  });

  it('パスワード不一致 → 400 wrongPassword', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(baseDbUser);
    vi.mocked(compare).mockResolvedValue(false as never);

    const res = await POST(buildRequest({ password: 'wrong', recoveryCode: 'abc' }) as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('VALIDATION_ERROR');
  });

  it('recoveryCode 不一致 → 400 wrongRecoveryCode', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(baseDbUser);
    vi.mocked(compare)
      .mockResolvedValueOnce(true as never) // password 一致
      .mockResolvedValue(false as never); // recoveryCode 全て不一致
    vi.mocked(prisma.recoveryCode.findMany).mockResolvedValue([
      { id: 'rc-1', codeHash: 'h1', usedAt: null },
    ] as never);

    const res = await POST(buildRequest({ password: 'correct', recoveryCode: 'wrong' }) as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('VALIDATION_ERROR');
  });

  it('成功: membership あり → $transaction で論理削除 + roleChangeLog.createMany + audit_logs に beforeValue 記録', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(baseDbUser);
    vi.mocked(compare).mockResolvedValue(true as never);
    vi.mocked(prisma.recoveryCode.findMany).mockResolvedValue([
      { id: 'rc-1', codeHash: 'h1', usedAt: null },
    ] as never);
    vi.mocked(prisma.recoveryCode.update).mockResolvedValue({} as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([
      { id: 'pm-1', projectId: 'p-1', projectRole: 'pm_tl' },
      { id: 'pm-2', projectId: 'p-2', projectRole: 'member' },
    ] as never);
    vi.mocked(prisma.roleChangeLog.createMany).mockResolvedValue({ count: 2 } as never);
    vi.mocked(prisma.projectMember.deleteMany).mockResolvedValue({ count: 2 } as never);
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 0 } as never);

    const res = await POST(buildRequest({ password: 'correct', recoveryCode: 'matching' }) as never);
    expect(res.status).toBe(200);

    // $transaction が 1 回呼ばれた (= 6 step が atomic)
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    // 論理削除
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u-self' },
        data: expect.objectContaining({ isActive: false, deletedAt: expect.any(Date) }),
      }),
    );

    // roleChangeLog.createMany で 2 行記録
    expect(prisma.roleChangeLog.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            tenantId: 'tenant-A',
            changedBy: 'u-self',
            targetUserId: 'u-self',
            changeType: 'project_role',
            projectId: 'p-1',
            beforeRole: 'pm_tl',
            afterRole: 'removed',
            reason: 'アカウント削除によるメンバー解除',
          }),
        ]),
      }),
    );

    // projectMember + session の物理削除
    expect(prisma.projectMember.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u-self' } });
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u-self' } });

    // audit_logs に beforeValue 記録 (S2-A2 回帰防止)
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DELETE',
        entityType: 'user',
        entityId: 'u-self',
        beforeValue: expect.objectContaining({
          id: 'u-self',
          email: 'self@example.com',
          systemRole: 'general',
        }),
        afterValue: expect.objectContaining({ action: 'self_delete' }),
      }),
    );
  });

  it('成功: membership 0 件 → roleChangeLog.createMany は呼ばれない', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(baseDbUser);
    vi.mocked(compare).mockResolvedValue(true as never);
    vi.mocked(prisma.recoveryCode.findMany).mockResolvedValue([
      { id: 'rc-1', codeHash: 'h1', usedAt: null },
    ] as never);
    vi.mocked(prisma.recoveryCode.update).mockResolvedValue({} as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([]);
    vi.mocked(prisma.projectMember.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 0 } as never);

    const res = await POST(buildRequest({ password: 'correct', recoveryCode: 'matching' }) as never);
    expect(res.status).toBe(200);

    // 0 件時 createMany は呼ばれない (空配列 createMany 回避)
    expect(prisma.roleChangeLog.createMany).not.toHaveBeenCalled();
  });
});
