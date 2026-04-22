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
      // PR #91: setupPassword が admin 判定のために findUnique を使用
      findUnique: vi.fn(),
    },
    recoveryCode: {
      createMany: vi.fn(),
    },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

const mockSend = vi.fn();
vi.mock('@/lib/mail', () => ({
  getMailProvider: () => ({ send: mockSend }),
}));

// setupPassword 内の動的 import 対策: bcryptjs を軽量モック化し、
// テスト実行時間が BCRYPT_COST に引きずられないようにする
vi.mock('bcryptjs', () => ({
  hash: vi.fn((v: string) => Promise.resolve(`hashed_${v}`)),
}));

// PR #91: admin 分岐で generateMfaSecret / qrcode を呼ぶのでモック化
vi.mock('./mfa.service', () => ({
  generateMfaSecret: vi.fn().mockResolvedValue({
    secret: 'MOCKSECRET',
    otpauthUri: 'otpauth://totp/test?secret=MOCKSECRET&issuer=tasukiba',
  }),
  verifyInitialTotpSecret: vi.fn(),
}));

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,MOCK_QR'),
  },
}));

import {
  sendVerificationEmail,
  verifyEmail,
  validateToken,
  setupPassword,
  setupInitialMfa,
  EmailSendError,
} from './email-verification.service';
import { prisma } from '@/lib/db';
import { verifyInitialTotpSecret } from './mfa.service';

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

describe('validateToken', () => {
  beforeEach(() => vi.clearAllMocks());

  it('トークン不在なら 無効なリンク', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue(null);
    const r = await validateToken('x');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('無効');
  });

  it('使用済みなら 既に使用', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'u',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: new Date(),
      createdAt: new Date(),
    });
    const r = await validateToken('x');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('使用');
  });

  it('期限切れなら 有効期限切れ', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'u',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() - 60000),
      usedAt: null,
      createdAt: new Date(),
    });
    const r = await validateToken('x');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('有効期限');
  });

  it('有効なら valid: true', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'u',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: null,
      createdAt: new Date(),
    });
    expect((await validateToken('x')).valid).toBe(true);
  });
});

describe('setupPassword', () => {
  beforeEach(() => vi.clearAllMocks());

  it('トークン不在で エラー', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue(null);
    const r = await setupPassword('x', 'hash');
    expect(r.success).toBe(false);
  });

  it('期限切れで エラー', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'u',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() - 60000),
      usedAt: null,
      createdAt: new Date(),
    });
    const r = await setupPassword('x', 'hash');
    expect(r.success).toBe(false);
  });

  it('一般ユーザ成功時: recoveryCodes + 即時有効化 (requiresMfa=false)', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'u-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: null,
      createdAt: new Date(),
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'u-1',
      systemRole: 'general',
    } as never);

    const r = await setupPassword('x', 'new-hash');

    expect(r.success).toBe(true);
    expect(r.requiresMfa).toBeFalsy();
    expect(Array.isArray(r.recoveryCodes)).toBe(true);
    expect(r.recoveryCodes?.length).toBeGreaterThan(0);
    // $transaction 内で token.usedAt 設定 + user.isActive=true + recoveryCode.createMany
    expect(prisma.$transaction).toHaveBeenCalled();
    const txCall = vi.mocked(prisma.$transaction).mock.calls[0][0] as unknown[];
    // 一般ユーザ用 transaction は 3 要素 (token update + user update + recoveryCode)
    expect(Array.isArray(txCall)).toBe(true);
    expect(txCall).toHaveLength(3);
  });

  it('PR #91 admin 成功時: requiresMfa=true + mfa データ返却 + token はまだ使用済にしない', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'admin-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: null,
      createdAt: new Date(),
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'admin-1',
      systemRole: 'admin',
    } as never);

    const r = await setupPassword('x', 'new-hash');

    expect(r.success).toBe(true);
    expect(r.requiresMfa).toBe(true);
    expect(r.mfa).toBeDefined();
    expect(r.mfa?.otpauthUri).toContain('otpauth://totp/');
    expect(r.mfa?.qrCodeDataUrl).toContain('data:image/png');
    expect(r.recoveryCodes?.length).toBeGreaterThan(0);

    // admin 用 transaction は 2 要素 (user update [isActive 設定しない] + recoveryCode)
    // token.usedAt は setupInitialMfa まで保持される
    const txCall = vi.mocked(prisma.$transaction).mock.calls[0][0] as unknown[];
    expect(txCall).toHaveLength(2);
  });

  it('使用済みトークンで エラー', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'u-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: new Date(),
      createdAt: new Date(),
    });
    const r = await setupPassword('x', 'hash');
    expect(r.success).toBe(false);
    expect(r.error).toContain('使用');
  });
});

describe('setupInitialMfa (PR #91)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('トークン不在で エラー', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue(null);
    const r = await setupInitialMfa('x', '123456');
    expect(r.success).toBe(false);
    expect(r.error).toContain('無効');
  });

  it('使用済みトークンで エラー', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'admin-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: new Date(),
      createdAt: new Date(),
    });
    const r = await setupInitialMfa('x', '123456');
    expect(r.success).toBe(false);
    expect(r.error).toContain('使用');
  });

  it('期限切れトークンで エラー', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'admin-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() - 60000),
      usedAt: null,
      createdAt: new Date(),
    });
    const r = await setupInitialMfa('x', '123456');
    expect(r.success).toBe(false);
    expect(r.error).toContain('有効期限');
  });

  it('MFA シークレット未設定で エラー (setupPassword 未実施)', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'admin-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: null,
      createdAt: new Date(),
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'admin-1',
      systemRole: 'admin',
      mfaSecretEncrypted: null,
    } as never);

    const r = await setupInitialMfa('x', '123456');
    expect(r.success).toBe(false);
    expect(r.error).toContain('シークレット');
  });

  it('TOTP コード不一致で エラー', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'admin-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: null,
      createdAt: new Date(),
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'admin-1',
      systemRole: 'admin',
      mfaSecretEncrypted: 'encrypted:xxx',
    } as never);
    vi.mocked(verifyInitialTotpSecret).mockResolvedValue(false);

    const r = await setupInitialMfa('x', '000000');
    expect(r.success).toBe(false);
    expect(r.error).toContain('正しくありません');
  });

  it('成功時: token 使用済 + user.isActive=true + mfaEnabled=true を同一トランザクションで実行', async () => {
    vi.mocked(prisma.emailVerificationToken.findFirst).mockResolvedValue({
      id: 't',
      userId: 'admin-1',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60000),
      usedAt: null,
      createdAt: new Date(),
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'admin-1',
      systemRole: 'admin',
      mfaSecretEncrypted: 'encrypted:xxx',
    } as never);
    vi.mocked(verifyInitialTotpSecret).mockResolvedValue(true);

    const r = await setupInitialMfa('x', '123456');

    expect(r.success).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalled();
    const txCall = vi.mocked(prisma.$transaction).mock.calls[0][0] as unknown[];
    expect(txCall).toHaveLength(2); // token update + user update
  });
});
