import { describe, it, expect, vi, beforeEach } from 'vitest';

// モック設定
vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    roleChangeLog: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    emailVerificationToken: {
      deleteMany: vi.fn(),
    },
    recoveryCode: {
      deleteMany: vi.fn(),
    },
    // PR #89: deleteUser が以下を物理削除する
    projectMember: { deleteMany: vi.fn() },
    session: { deleteMany: vi.fn() },
    passwordResetToken: { deleteMany: vi.fn() },
    passwordHistory: { deleteMany: vi.fn() },
    // 2026-04-24: deleteUser が Memo もカスケード物理削除する
    memo: { deleteMany: vi.fn() },
    // feat/account-lock: lockInactiveUsers が audit_log を直接記録する
    auditLog: { create: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

vi.mock('./email-verification.service', async () => {
  class EmailSendError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'EmailSendError';
    }
  }
  return {
    sendVerificationEmail: vi.fn(),
    EmailSendError,
  };
});

vi.mock('bcryptjs', () => ({
  hash: vi.fn((val: string) => Promise.resolve(`hashed_${val}`)),
}));

import {
  createUser,
  listUsers,
  updateUser,
  updateUserStatus,
  updateUserRole,
  deleteUser,
  lockInactiveUsers,
} from './user.service';
import { prisma } from '@/lib/db';
import {
  sendVerificationEmail,
  EmailSendError,
} from './email-verification.service';

const validInput = {
  name: 'テストユーザ',
  email: 'test@example.com',
  systemRole: 'general' as const,
};

const creatorId = 'creator-uuid';

describe('createUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.user.create).mockResolvedValue({
      id: 'new-user-id',
      name: validInput.name,
      email: validInput.email,
      passwordHash: 'hashed_placeholder',
      systemRole: validInput.systemRole,
      isActive: false,
      failedLoginCount: 0,
      lockedUntil: null,
      permanentLock: false,
      mfaEnabled: false,
      mfaSecretEncrypted: null,
      mfaEnabledAt: null,
      lastLoginAt: null,
      forcePasswordChange: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: new Date(),
    });
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);
    vi.mocked(sendVerificationEmail).mockResolvedValue();
  });

  it('有効な入力でユーザを作成する（パスワードなし、リカバリーコードなし）', async () => {
    const result = await createUser(validInput, creatorId, { baseUrl: 'https://example.com' });

    expect(result.user.name).toBe(validInput.name);
    expect(result.user.email).toBe(validInput.email);
    expect(result.user.isActive).toBe(false);
    expect(prisma.user.create).toHaveBeenCalledOnce();
    expect(prisma.roleChangeLog.create).toHaveBeenCalledOnce();
  });

  it('招待メールを送信する', async () => {
    await createUser(validInput, creatorId, { baseUrl: 'https://example.com' });

    expect(sendVerificationEmail).toHaveBeenCalledWith(
      'new-user-id',
      validInput.email,
      'https://example.com',
    );
  });

  it('既に有効なユーザが存在する場合は DUPLICATE_EMAIL エラー', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({
      id: 'existing-id',
      deletedAt: null,
    } as never);

    await expect(createUser(validInput, creatorId)).rejects.toThrow('DUPLICATE_EMAIL');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('未有効化の既存ユーザがある場合は削除してから再登録する', async () => {
    vi.mocked(prisma.user.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'inactive-user-id',
        email: validInput.email,
        isActive: false,
        deletedAt: new Date(),
      } as never);

    const result = await createUser(validInput, creatorId, { baseUrl: 'https://example.com' });

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(result.user.email).toBe(validInput.email);
  });

  it('メール送信失敗時はユーザをロールバックして EMAIL_SEND_FAILED エラー', async () => {
    vi.mocked(sendVerificationEmail).mockRejectedValue(
      new EmailSendError('送信失敗'),
    );

    await expect(
      createUser(validInput, creatorId, { baseUrl: 'https://example.com' }),
    ).rejects.toThrow('EMAIL_SEND_FAILED');

    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('baseUrl 未指定の場合はメール送信をスキップする', async () => {
    await createUser(validInput, creatorId);

    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });
});

const baseUserRow = {
  id: 'u-1',
  name: 'Alice',
  email: 'a@b.co',
  systemRole: 'general',
  isActive: true,
  createdAt: new Date('2026-04-01'),
  updatedAt: new Date('2026-04-01'),
  // PR #85: ロック情報 (UserDTO 拡張)
  failedLoginCount: 0,
  lockedUntil: null as Date | null,
  permanentLock: false,
};

describe('listUsers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('削除済みを除外して DTO で返す', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([baseUserRow] as never);

    const r = await listUsers();

    expect(r[0].id).toBe('u-1');
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } }),
    );
  });
});

describe('updateUserStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('有効化 → before=inactive / after=active の監査ログ', async () => {
    vi.mocked(prisma.user.update).mockResolvedValue(baseUserRow as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    await updateUserStatus('u-1', true, 'admin-1');

    expect(prisma.roleChangeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          beforeRole: 'inactive',
          afterRole: 'active',
        }),
      }),
    );
  });

  it('無効化 → before=active / after=inactive', async () => {
    vi.mocked(prisma.user.update).mockResolvedValue(baseUserRow as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    await updateUserStatus('u-1', false, 'admin-1');

    expect(prisma.roleChangeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          beforeRole: 'active',
          afterRole: 'inactive',
        }),
      }),
    );
  });
});

describe('updateUserRole', () => {
  beforeEach(() => vi.clearAllMocks());

  it('自分自身のロール変更は CANNOT_CHANGE_OWN_ROLE', async () => {
    await expect(updateUserRole('same-id', 'admin', 'same-id')).rejects.toThrow(
      'CANNOT_CHANGE_OWN_ROLE',
    );
  });

  it('対象ユーザ不在で NOT_FOUND', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    await expect(updateUserRole('u-1', 'admin', 'admin-1')).rejects.toThrow('NOT_FOUND');
  });

  it('ロール更新 + 監査ログ記録', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...baseUserRow,
      systemRole: 'general',
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      ...baseUserRow,
      systemRole: 'admin',
    } as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    const r = await updateUserRole('u-1', 'admin', 'admin-1');

    expect(r.systemRole).toBe('admin');
    expect(prisma.roleChangeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          beforeRole: 'general',
          afterRole: 'admin',
        }),
      }),
    );
  });
});

describe('updateUser (汎用ディスパッチ)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('name のみ指定時は user.update のみ (role_change_log なし)', async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({
      ...baseUserRow,
      name: 'New',
    } as never);

    const r = await updateUser('u-1', { name: 'New' }, 'admin-1');

    expect(r.name).toBe('New');
    expect(prisma.roleChangeLog.create).not.toHaveBeenCalled();
  });

  it('systemRole 指定時は updateUserRole 経路', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...baseUserRow,
      systemRole: 'general',
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      ...baseUserRow,
      systemRole: 'admin',
    } as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    await updateUser('u-1', { systemRole: 'admin' }, 'admin-1');

    expect(prisma.roleChangeLog.create).toHaveBeenCalled();
  });

  it('isActive 指定時は updateUserStatus 経路', async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({
      ...baseUserRow,
      isActive: false,
    } as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    await updateUser('u-1', { isActive: false }, 'admin-1');

    expect(prisma.roleChangeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ afterRole: 'inactive' }),
      }),
    );
  });

  it('空入力時は findUniqueOrThrow で現在値を返す', async () => {
    vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue(baseUserRow as never);

    const r = await updateUser('u-1', {}, 'admin-1');

    expect(r.id).toBe('u-1');
    expect(prisma.roleChangeLog.create).not.toHaveBeenCalled();
  });
});

describe('deleteUser (PR #89)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('自分自身の削除は CANNOT_DELETE_SELF', async () => {
    await expect(deleteUser('same-id', 'same-id')).rejects.toThrow('CANNOT_DELETE_SELF');
  });

  it('対象ユーザ不在で NOT_FOUND', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    await expect(deleteUser('u-1', 'admin-1')).rejects.toThrow('NOT_FOUND');
  });

  it('論理削除 + ProjectMember など関連データを物理削除', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(baseUserRow as never);
    vi.mocked(prisma.projectMember.deleteMany).mockResolvedValue({ count: 3 } as never);
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 2 } as never);
    vi.mocked(prisma.recoveryCode.deleteMany).mockResolvedValue({ count: 10 } as never);
    vi.mocked(prisma.emailVerificationToken.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.passwordResetToken.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.passwordHistory.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.memo.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    const r = await deleteUser('u-1', 'admin-1');

    expect(r.deletedUserId).toBe('u-1');
    expect(r.removedMemberships).toBe(3);
    // User 本体は deletedAt セット + isActive=false + MFA 無効化
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u-1' },
        data: expect.objectContaining({
          deletedAt: expect.any(Date),
          isActive: false,
          mfaEnabled: false,
          mfaSecretEncrypted: null,
        }),
      }),
    );
    // 削除ログ
    expect(prisma.roleChangeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ afterRole: 'deleted', reason: 'ユーザ削除' }),
      }),
    );
  });

  it('2026-04-24: Memo は対象ユーザの全件をカスケード物理削除する', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(baseUserRow as never);
    vi.mocked(prisma.projectMember.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.recoveryCode.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.emailVerificationToken.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.passwordResetToken.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.passwordHistory.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.memo.deleteMany).mockResolvedValue({ count: 5 } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    await deleteUser('u-1', 'admin-1');

    // Memo.deleteMany が userId=u-1 で 1 回呼ばれたこと
    expect(prisma.memo.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u-1' } });
    expect(prisma.memo.deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe('lockInactiveUsers (PR #89 + feat/account-lock 改修)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('候補が 0 件なら何もしない', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    const r = await lockInactiveUsers('admin-1');

    expect(r.lockedUserIds).toEqual([]);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('非 admin + lastLoginAt/createdAt 閾値超えを抽出し、isActive=false に更新 (論理削除しない)', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: 'u-stale-1', name: 'A', email: 'a@example.com' },
      { id: 'u-stale-2', name: 'B', email: 'b@example.com' },
    ] as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);

    const r = await lockInactiveUsers('admin-1');

    expect(r.lockedUserIds).toEqual(['u-stale-1', 'u-stale-2']);

    // where: admin を除外 + lastLoginAt < 閾値 OR (lastLoginAt null && createdAt < 閾値)
    const findCall = vi.mocked(prisma.user.findMany).mock.calls[0][0];
    expect(findCall?.where?.systemRole).toEqual({ not: 'admin' });
    expect(findCall?.where?.isActive).toBe(true);
    expect(findCall?.where?.deletedAt).toBe(null);

    // user.update が isActive:false で 2 回呼ばれる (論理削除では deletedAt をセットするが
    // ロックは isActive のみ。deletedAt 設定 / projectMember 物理削除は行わない)
    expect(prisma.user.update).toHaveBeenCalledTimes(2);
    const firstUpdate = vi.mocked(prisma.user.update).mock.calls[0][0];
    expect(firstUpdate.data).toMatchObject({ isActive: false });
    expect(firstUpdate.data).not.toHaveProperty('deletedAt');
    expect(prisma.projectMember.deleteMany).not.toHaveBeenCalled();
  });

  it('個別 update が失敗しても次のユーザ処理を継続', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: 'u-bad', name: 'X', email: 'x@example.com' },
      { id: 'u-good', name: 'Y', email: 'y@example.com' },
    ] as never);
    vi.mocked(prisma.user.update)
      .mockRejectedValueOnce(new Error('DB error') as never)
      .mockResolvedValueOnce({} as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);

    const r = await lockInactiveUsers('admin-1');

    // u-bad は失敗したので 1 件のみ成功
    expect(r.lockedUserIds).toEqual(['u-good']);
  });
});
