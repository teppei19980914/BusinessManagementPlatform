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
