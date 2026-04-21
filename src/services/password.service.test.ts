import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
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

import { changePassword, unlockAccount } from './password.service';
import { prisma } from '@/lib/db';
import { compare } from 'bcryptjs';
import { recordAuthEvent } from './auth-event.service';

describe('changePassword', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ユーザが存在しない場合はエラー', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    const res = await changePassword('u1', 'old', 'new');

    expect(res.success).toBe(false);
    expect(res.error).toContain('ユーザ');
  });

  it('現在のパスワードが誤りの場合はエラー', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'u1',
      passwordHash: 'hashed_real',
    } as never);
    vi.mocked(compare).mockResolvedValueOnce(false); // 現行照合 false

    const res = await changePassword('u1', 'wrong', 'new');

    expect(res.success).toBe(false);
    expect(res.error).toContain('正しくありません');
  });

  it('履歴に存在するパスワードは再利用不可', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'u1',
      passwordHash: 'hashed_real',
    } as never);
    // 現行照合 true, 履歴 1 件が再利用マッチ
    vi.mocked(compare)
      .mockResolvedValueOnce(true) // 現在パスワード照合
      .mockResolvedValueOnce(true); // 履歴 1 件目が一致
    vi.mocked(prisma.passwordHistory.findMany).mockResolvedValue([
      { passwordHash: 'hashed_old' },
    ] as never);

    const res = await changePassword('u1', 'current', 'newpass');

    expect(res.success).toBe(false);
    expect(res.error).toContain('再利用');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('現在パスワードと同じ新パスワードは不可', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'u1',
      passwordHash: 'hashed_real',
    } as never);
    vi.mocked(compare)
      .mockResolvedValueOnce(true) // 現在照合 ok
      // 履歴は空
      .mockResolvedValueOnce(true); // 新=現在 判定で一致
    vi.mocked(prisma.passwordHistory.findMany).mockResolvedValue([]);

    const res = await changePassword('u1', 'same', 'same');

    expect(res.success).toBe(false);
    expect(res.error).toContain('同じ');
  });

  it('成功: トランザクションで更新 + history 追加 + 監査ログ', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'u1',
      passwordHash: 'hashed_real',
    } as never);
    vi.mocked(compare)
      .mockResolvedValueOnce(true) // 現行 ok
      .mockResolvedValueOnce(false); // 新!=現行
    vi.mocked(prisma.passwordHistory.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    vi.mocked(prisma.passwordHistory.create).mockResolvedValue({} as never);

    const res = await changePassword('u1', 'current', 'brandnew');

    expect(res.success).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(recordAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'password_change', userId: 'u1' }),
    );
  });
});

describe('unlockAccount', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ロック情報をクリアして監査ログに account_reactivated を残す', async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    await unlockAccount('u1', 'admin-1');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { failedLoginCount: 0, lockedUntil: null, permanentLock: false },
    });
    expect(recordAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'account_reactivated',
        userId: 'u1',
        detail: expect.objectContaining({ unlockedBy: 'admin-1' }),
      }),
    );
  });
});
