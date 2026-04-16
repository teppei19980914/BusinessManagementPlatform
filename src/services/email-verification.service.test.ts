import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    emailVerificationToken: {
      updateMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    user: {
      update: vi.fn(),
    },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

const mockSend = vi.fn();
vi.mock('@/lib/mail', () => ({
  getMailProvider: () => ({ send: mockSend }),
}));

import { sendVerificationEmail, verifyEmail, EmailSendError } from './email-verification.service';
import { prisma } from '@/lib/db';

describe('sendVerificationEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.emailVerificationToken.updateMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.emailVerificationToken.create).mockResolvedValue({} as never);
  });

  it('メール送信成功時は正常に完了する', async () => {
    mockSend.mockResolvedValue({ success: true, messageId: 'msg-123' });

    await expect(
      sendVerificationEmail('user-id', 'test@example.com', 'https://example.com'),
    ).resolves.toBeUndefined();

    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend.mock.calls[0][0].to).toBe('test@example.com');
  });

  it('メール送信失敗時は EmailSendError をスローする', async () => {
    mockSend.mockResolvedValue({ success: false, error: 'Resend 403 error' });

    await expect(
      sendVerificationEmail('user-id', 'test@example.com', 'https://example.com'),
    ).rejects.toThrow(EmailSendError);
  });

  it('既存の未使用トークンを無効化してから新しいトークンを作成する', async () => {
    mockSend.mockResolvedValue({ success: true, messageId: 'msg-456' });

    await sendVerificationEmail('user-id', 'test@example.com', 'https://example.com');

    expect(prisma.emailVerificationToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-id', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    expect(prisma.emailVerificationToken.create).toHaveBeenCalledOnce();
  });
});

describe('verifyEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('有効なトークンでアカウントを有効化する', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 'token-id',
      userId: 'user-id',
      tokenHash: 'hash',
      expiresAt: new Date(Date.now() + 3600000),
      usedAt: null,
      createdAt: new Date(),
    });

    const result = await verifyEmail('valid-token');

    expect(result.success).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('存在しないトークンでエラーを返す', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue(null);

    const result = await verifyEmail('invalid-token');

    expect(result.success).toBe(false);
    expect(result.error).toBe('無効なリンクです');
  });

  it('使用済みトークンでエラーを返す', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 'token-id',
      userId: 'user-id',
      tokenHash: 'hash',
      expiresAt: new Date(Date.now() + 3600000),
      usedAt: new Date(),
      createdAt: new Date(),
    });

    const result = await verifyEmail('used-token');

    expect(result.success).toBe(false);
    expect(result.error).toBe('既に使用されたリンクです');
  });

  it('有効期限切れトークンでエラーを返す', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 'token-id',
      userId: 'user-id',
      tokenHash: 'hash',
      expiresAt: new Date(Date.now() - 1000),
      usedAt: null,
      createdAt: new Date(),
    });

    const result = await verifyEmail('expired-token');

    expect(result.success).toBe(false);
    expect(result.error).toBe('有効期限切れです。管理者に再送を依頼してください');
  });
});

describe('EmailSendError', () => {
  it('Error を継承し name が EmailSendError である', () => {
    const err = new EmailSendError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EmailSendError');
    expect(err.message).toBe('test');
  });
});
