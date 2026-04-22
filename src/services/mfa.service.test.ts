import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('./auth-event.service', () => ({
  recordAuthEvent: vi.fn().mockResolvedValue(undefined),
}));

import {
  generateMfaSecret,
  enableMfa,
  disableMfa,
  verifyTotp,
} from './mfa.service';
import { prisma } from '@/lib/db';
import { recordAuthEvent } from './auth-event.service';

describe('TOTP (otplib) 低レベル動作', () => {
  it('シークレット生成・検証ができる', async () => {
    const otplib = await import('otplib');
    const secret = otplib.generateSecret();
    expect(secret).toBeDefined();
    const token = otplib.generateSync({ secret });
    expect(token).toHaveLength(6);
    expect(otplib.verifySync({ token, secret }).valid).toBe(true);
  });

  it('不正なコードで検証が失敗する', async () => {
    const otplib = await import('otplib');
    const secret = otplib.generateSecret();
    expect(otplib.verifySync({ token: '000000', secret }).valid).toBe(false);
  });

  it('otpauth URI が生成できる', async () => {
    const otplib = await import('otplib');
    const secret = otplib.generateSecret();
    const uri = otplib.generateURI({
      label: 'test@example.com',
      issuer: 'TestApp',
      secret,
    });
    expect(uri).toContain('otpauth://totp/');
  });
});

describe('generateMfaSecret', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ユーザ不在で NOT_FOUND', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    await expect(generateMfaSecret('u1')).rejects.toThrow('NOT_FOUND');
  });

  it('シークレットを生成して user.update を呼ぶ', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'u1',
      email: 'a@b.co',
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const result = await generateMfaSecret('u1');

    expect(result.secret).toBeDefined();
    expect(result.otpauthUri).toContain('otpauth://totp/');
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({
          mfaSecretEncrypted: expect.any(String),
        }),
      }),
    );
  });
});

describe('enableMfa', () => {
  beforeEach(() => vi.clearAllMocks());

  it('シークレット未生成でエラー', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ mfaSecretEncrypted: null } as never);
    const r = await enableMfa('u1', '123456');
    expect(r.success).toBe(false);
    expect(r.error).toContain('シークレット');
  });

  it('TOTP コードが誤りでエラー', async () => {
    // 先に generateMfaSecret を通してシークレットを DB に格納する
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u1',
      email: 'a@b.co',
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    let savedEncrypted = '';
    vi.mocked(prisma.user.update).mockImplementationOnce(async (args) => {
      savedEncrypted = (args.data as { mfaSecretEncrypted: string }).mfaSecretEncrypted;
      return {} as never;
    });
    await generateMfaSecret('u1');

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u1',
      mfaSecretEncrypted: savedEncrypted,
    } as never);

    const r = await enableMfa('u1', '000000');
    expect(r.success).toBe(false);
  });

  it('TOTP が正しければ有効化成功 + 監査ログ', async () => {
    // 事前にシークレット発行
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u1',
      email: 'a@b.co',
    } as never);
    let savedEncrypted = '';
    vi.mocked(prisma.user.update).mockImplementationOnce(async (args) => {
      savedEncrypted = (args.data as { mfaSecretEncrypted: string }).mfaSecretEncrypted;
      return {} as never;
    });
    const gen = await generateMfaSecret('u1');

    // 正しい TOTP コード生成
    const otplib = await import('otplib');
    const validCode = otplib.generateSync({ secret: gen.secret });

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      mfaSecretEncrypted: savedEncrypted,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as never);

    const r = await enableMfa('u1', validCode);
    expect(r.success).toBe(true);
    expect(recordAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ action: 'mfa_enabled' }) }),
    );
  });
});

describe('disableMfa', () => {
  beforeEach(() => vi.clearAllMocks());

  it('一般ユーザ: MFA 関連フィールドをクリアして監査ログを残す', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ systemRole: 'general' } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    await disableMfa('u1');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { mfaEnabled: false, mfaSecretEncrypted: null, mfaEnabledAt: null },
    });
    expect(recordAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ action: 'mfa_disabled' }) }),
    );
  });

  it('PR #91: admin は CANNOT_DISABLE_ADMIN_MFA を throw (サービス層防御)', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ systemRole: 'admin' } as never);

    await expect(disableMfa('admin-1')).rejects.toThrow('CANNOT_DISABLE_ADMIN_MFA');
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(recordAuthEvent).not.toHaveBeenCalled();
  });
});

describe('verifyTotp', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ユーザ不在で false', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    expect(await verifyTotp('u1', '123456')).toBe(false);
  });

  it('MFA 無効で false', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      mfaEnabled: false,
      mfaSecretEncrypted: null,
    } as never);
    expect(await verifyTotp('u1', '123456')).toBe(false);
  });

  it('正しい TOTP で true', async () => {
    // 事前に encrypt されたシークレットを用意
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u1',
      email: 'a@b.co',
    } as never);
    let savedEncrypted = '';
    vi.mocked(prisma.user.update).mockImplementationOnce(async (args) => {
      savedEncrypted = (args.data as { mfaSecretEncrypted: string }).mfaSecretEncrypted;
      return {} as never;
    });
    const gen = await generateMfaSecret('u1');

    const otplib = await import('otplib');
    const code = otplib.generateSync({ secret: gen.secret });

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      mfaEnabled: true,
      mfaSecretEncrypted: savedEncrypted,
    } as never);

    expect(await verifyTotp('u1', code)).toBe(true);
  });

  it('誤った TOTP で false', async () => {
    // 事前に encrypt されたシークレットを用意
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u1',
      email: 'a@b.co',
    } as never);
    let savedEncrypted = '';
    vi.mocked(prisma.user.update).mockImplementationOnce(async (args) => {
      savedEncrypted = (args.data as { mfaSecretEncrypted: string }).mfaSecretEncrypted;
      return {} as never;
    });
    await generateMfaSecret('u1');

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      mfaEnabled: true,
      mfaSecretEncrypted: savedEncrypted,
    } as never);

    expect(await verifyTotp('u1', '000000')).toBe(false);
  });
});
