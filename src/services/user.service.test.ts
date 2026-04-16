import { describe, it, expect, vi, beforeEach } from 'vitest';

// モック設定
vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findFirst: vi.fn(),
      create: vi.fn(),
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

import { createUser } from './user.service';
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
