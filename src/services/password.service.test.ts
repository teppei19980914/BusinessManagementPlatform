import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
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
    vi.mocked(compare).mockResolvedValueOnce(false as never); // 現行照合 false

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
      .mockResolvedValueOnce(true as never) // 現在パスワード照合
      .mockResolvedValueOnce(true as never); // 履歴 1 件目が一致
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
      .mockResolvedValueOnce(true as never) // 現在照合 ok
      // 履歴は空
      .mockResolvedValueOnce(true as never); // 新=現在 判定で一致
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
      .mockResolvedValueOnce(true as never) // 現行 ok
      .mockResolvedValueOnce(false as never); // 新!=現行
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

  // 2026-05-13 (security/jwt-invalidation, L-1 follow-up): 回帰テスト。
  //   changePassword は **自分自身の操作** のため tokenVersion を increment してはならない。
  //   increment すると同セッションの JWT (= 古い tokenVersion) が DB と不一致になり、
  //   直後の API 呼び出しで SESSION_INVALIDATED 401 で弾かれる (E2E spec 01 Step 2 で発覚)。
  //   admin による他人操作 (unlockAccount / updateUserStatus / updateUserRole / deleteUser)
  //   では引き続き increment するため、本テストは「自分操作のみ skip」の境界を保証する。
  it('回帰: 自分のパスワード変更では tokenVersion を increment しない (同セッション SESSION_INVALIDATED 防止)', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'u1',
      passwordHash: 'hashed_real',
      tenantId: 'tenant-A',
    } as never);
    vi.mocked(compare)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(false as never);
    vi.mocked(prisma.passwordHistory.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    vi.mocked(prisma.passwordHistory.create).mockResolvedValue({} as never);

    await changePassword('u1', 'current', 'brandnew');

    // prisma.user.update の呼び出し data に tokenVersion が含まれていない事を assert
    const updateCall = vi.mocked(prisma.user.update).mock.calls[0]?.[0];
    expect(updateCall?.data).toBeDefined();
    expect(updateCall?.data).not.toHaveProperty('tokenVersion');
  });
});

describe('unlockAccount', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ロック情報をクリアして監査ログに account_reactivated を残す (T-21: temporaryLockCount もリセット)', async () => {
    // Phase 2-10: tenantId フィルタ付き updateMany で越境 unlock 遮断
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 } as never);

    await unlockAccount('u1', 'admin-1', 'tenant-A');

    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', tenantId: 'tenant-A' },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        permanentLock: false,
        temporaryLockCount: 0,
        // 2026-05-13 (security/jwt-invalidation, L-1): unlock で既存 JWT を失効
        tokenVersion: { increment: 1 },
      },
    });
    expect(recordAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'account_reactivated',
        tenantId: 'tenant-A',
        userId: 'u1',
        detail: expect.objectContaining({ unlockedBy: 'admin-1' }),
      }),
    );
  });
});
