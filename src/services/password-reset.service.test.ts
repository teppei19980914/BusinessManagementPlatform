import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findFirst: vi.fn(), update: vi.fn() },
    recoveryCode: { findMany: vi.fn(), update: vi.fn() },
    passwordResetToken: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    passwordHistory: { findMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

vi.mock('bcryptjs', () => ({
  hash: vi.fn((v: string) => Promise.resolve(`hashed_${v}`)),
  compare: vi.fn(),
}));

vi.mock('./auth-event.service', () => ({
  recordAuthEvent: vi.fn().mockResolvedValue(undefined),
}));

import { verifyAndIssueResetToken, resetPassword } from './password-reset.service';
import { prisma } from '@/lib/db';
import { compare } from 'bcryptjs';

describe('verifyAndIssueResetToken', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ユーザ不在の場合は汎用エラー (ユーザ存在漏洩防止)', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

    const res = await verifyAndIssueResetToken('nobody@example.com', 'code');

    expect(res.success).toBe(false);
    expect(res.error).toContain('正しくありません');
  });

  it('リカバリーコード不一致は汎用エラー + 監査ログ', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'u1' } as never);
    vi.mocked(prisma.recoveryCode.findMany).mockResolvedValue([
      { id: 'c1', codeHash: 'h1' },
    ] as never);
    vi.mocked(compare).mockResolvedValue(false);

    const res = await verifyAndIssueResetToken('a@b.co', 'wrongcode');

    expect(res.success).toBe(false);
    expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
  });

  it('成功: リカバリーコード使用済みマーク + トークン発行', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'u1' } as never);
    vi.mocked(prisma.recoveryCode.findMany).mockResolvedValue([
      { id: 'c1', codeHash: 'h1' },
    ] as never);
    vi.mocked(compare).mockResolvedValueOnce(true);
    vi.mocked(prisma.recoveryCode.update).mockResolvedValue({} as never);
    vi.mocked(prisma.passwordResetToken.create).mockResolvedValue({} as never);

    const res = await verifyAndIssueResetToken('a@b.co', 'goodcode');

    expect(res.success).toBe(true);
    expect(res.token).toMatch(/^[a-f0-9]{64}$/);
    expect(prisma.recoveryCode.update).toHaveBeenCalled();
    expect(prisma.passwordResetToken.create).toHaveBeenCalled();
  });
});

describe('resetPassword', () => {
  beforeEach(() => vi.clearAllMocks());

  it('トークンが無効なら 無効なリンク エラー', async () => {
    vi.mocked(prisma.passwordResetToken.findFirst).mockResolvedValue(null);

    const res = await resetPassword('any', 'newpass');

    expect(res.success).toBe(false);
    expect(res.error).toContain('無効');
  });

  it('既に使用済みなら エラー', async () => {
    vi.mocked(prisma.passwordResetToken.findFirst).mockResolvedValue({
      id: 't1',
      userId: 'u1',
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
    } as never);

    const res = await resetPassword('any', 'newpass');

    expect(res.success).toBe(false);
    expect(res.error).toContain('使用');
  });

  it('期限切れなら エラー', async () => {
    vi.mocked(prisma.passwordResetToken.findFirst).mockResolvedValue({
      id: 't1',
      userId: 'u1',
      usedAt: null,
      expiresAt: new Date(Date.now() - 60000),
    } as never);

    const res = await resetPassword('any', 'newpass');

    expect(res.success).toBe(false);
    expect(res.error).toContain('有効期限');
  });

  it('履歴再利用なら エラー (トランザクションには進まない)', async () => {
    vi.mocked(prisma.passwordResetToken.findFirst).mockResolvedValue({
      id: 't1',
      userId: 'u1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60000),
    } as never);
    vi.mocked(prisma.passwordHistory.findMany).mockResolvedValue([
      { passwordHash: 'h_old' },
    ] as never);
    vi.mocked(compare).mockResolvedValueOnce(true);

    const res = await resetPassword('any', 'reused');

    expect(res.success).toBe(false);
    expect(res.error).toContain('再利用');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('成功: トランザクションで token 消費 + user 更新 + history 追加', async () => {
    vi.mocked(prisma.passwordResetToken.findFirst).mockResolvedValue({
      id: 't1',
      userId: 'u1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60000),
    } as never);
    vi.mocked(prisma.passwordHistory.findMany).mockResolvedValue([]);

    const res = await resetPassword('any', 'brandnew');

    expect(res.success).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
