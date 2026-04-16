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
  password: 'Abcdefgh12!',
  systemRole: 'general' as const,
};

const creatorId = 'creator-uuid';

describe('createUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // デフォルト: MAIL_PROVIDER=console（メール送信スキップ）
    process.env.MAIL_PROVIDER = 'console';

    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.user.create).mockResolvedValue({
      id: 'new-user-id',
      name: validInput.name,
      email: validInput.email,
      passwordHash: 'hashed',
      systemRole: validInput.systemRole,
      isActive: true,
      failedLoginCount: 0,
      lockedUntil: null,
      permanentLock: false,
      mfaEnabled: false,
      mfaSecretEncrypted: null,
      mfaEnabledAt: null,
      lastLoginAt: null,
      forcePasswordChange: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);
  });

  it('有効な入力でユーザを作成し、リカバリーコードを返す', async () => {
    const result = await createUser(validInput, creatorId);

    expect(result.user.name).toBe(validInput.name);
    expect(result.user.email).toBe(validInput.email);
    expect(result.recoveryCodes).toHaveLength(10);
    expect(prisma.user.create).toHaveBeenCalledOnce();
    expect(prisma.roleChangeLog.create).toHaveBeenCalledOnce();
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
    // 1回目: 有効ユーザなし、2回目: 未有効化ユーザあり
    vi.mocked(prisma.user.findFirst)
      .mockResolvedValueOnce(null) // existingActive
      .mockResolvedValueOnce({
        id: 'inactive-user-id',
        email: validInput.email,
        isActive: false,
        deletedAt: new Date(),
      } as never);

    const result = await createUser(validInput, creatorId);

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(result.user.email).toBe(validInput.email);
  });

  it('MAIL_PROVIDER=console の場合はメール送信をスキップする', async () => {
    process.env.MAIL_PROVIDER = 'console';

    await createUser(validInput, creatorId, { baseUrl: 'https://example.com' });

    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('MAIL_PROVIDER=resend の場合はメール送信を実行する', async () => {
    process.env.MAIL_PROVIDER = 'resend';
    vi.mocked(prisma.user.create).mockResolvedValue({
      id: 'new-user-id',
      name: validInput.name,
      email: validInput.email,
      passwordHash: 'hashed',
      systemRole: validInput.systemRole,
      isActive: false,
      failedLoginCount: 0,
      lockedUntil: null,
      permanentLock: false,
      mfaEnabled: false,
      mfaSecretEncrypted: null,
      mfaEnabledAt: null,
      lastLoginAt: null,
      forcePasswordChange: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: new Date(),
    });
    vi.mocked(sendVerificationEmail).mockResolvedValue();

    await createUser(validInput, creatorId, { baseUrl: 'https://example.com' });

    expect(sendVerificationEmail).toHaveBeenCalledWith(
      'new-user-id',
      validInput.email,
      'https://example.com',
    );
  });

  it('メール送信失敗時はユーザをロールバックして EMAIL_SEND_FAILED エラー', async () => {
    process.env.MAIL_PROVIDER = 'resend';
    vi.mocked(prisma.user.create).mockResolvedValue({
      id: 'new-user-id',
      name: validInput.name,
      email: validInput.email,
      passwordHash: 'hashed',
      systemRole: validInput.systemRole,
      isActive: false,
      failedLoginCount: 0,
      lockedUntil: null,
      permanentLock: false,
      mfaEnabled: false,
      mfaSecretEncrypted: null,
      mfaEnabledAt: null,
      lastLoginAt: null,
      forcePasswordChange: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: new Date(),
    });
    vi.mocked(sendVerificationEmail).mockRejectedValue(
      new EmailSendError('Resend 403'),
    );

    await expect(
      createUser(validInput, creatorId, { baseUrl: 'https://example.com' }),
    ).rejects.toThrow('EMAIL_SEND_FAILED');

    // ロールバック用の $transaction が呼ばれていること
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('リカバリーコードは XXXX-XXXX 形式で生成される', async () => {
    const result = await createUser(validInput, creatorId);

    for (const code of result.recoveryCodes) {
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    }
  });
});
