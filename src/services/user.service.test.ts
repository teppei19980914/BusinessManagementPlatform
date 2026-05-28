import { describe, it, expect, vi, beforeEach } from 'vitest';

// モック設定
vi.mock('@/lib/db', () => {
  // feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S2-D5):
  //   lockInactiveUsers の transaction 化に対応するため、prismaMock を outer 参照可能にし、
  //   $transaction が callback 形式 (interactive transaction) で呼ばれた場合と
  //   配列形式 (`$transaction([ops])`) で呼ばれた場合の両対応にする。
  const prismaMock = {
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    tenant: { findUnique: vi.fn() },
    roleChangeLog: {
      create: vi.fn(),
      createMany: vi.fn().mockResolvedValue({ count: 0 } as never),
      deleteMany: vi.fn(),
    },
    emailVerificationToken: { deleteMany: vi.fn() },
    recoveryCode: { deleteMany: vi.fn() },
    projectMember: { deleteMany: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    session: { deleteMany: vi.fn() },
    passwordResetToken: { deleteMany: vi.fn() },
    passwordHistory: { deleteMany: vi.fn() },
    memo: { deleteMany: vi.fn() },
    auditLog: { create: vi.fn(), createMany: vi.fn() },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: vi.fn(async (arg: any) => {
      if (typeof arg === 'function') {
        // interactive transaction (callback 形式): tx に prismaMock を渡す
        return arg(prismaMock);
      }
      // 配列形式: 全 promise を解決
      return Promise.all(arg);
    }),
  };
  return { prisma: prismaMock };
});

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
  assertSeatAvailableForTenant,
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
  // ★severity-1 (fix/tenant-id-default-removal, 2026-05-28): tenantId を必須引数化したため、
  //   既定 tenantId を全テストに適用 (旧シグネチャ互換テストは削除)。
  const DEFAULT_TEST_TENANT_ID = 'tenant-A';

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.user.create).mockResolvedValue({
      id: 'new-user-id',
      // Phase 2-10: sendVerificationEmail に tenantId 必須、user.create のレスポンスでも返す
      tenantId: 'tenant-A',
      name: validInput.name,
      email: validInput.email,
      passwordHash: 'hashed_placeholder',
      systemRole: validInput.systemRole,
      isActive: false,
      failedLoginCount: 0,
      lockedUntil: null,
      permanentLock: false,
      temporaryLockCount: 0,
      mfaEnabled: false,
      mfaSecretEncrypted: null,
      mfaEnabledAt: null,
      lastLoginAt: null,
      forcePasswordChange: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: new Date(),
    } as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);
    vi.mocked(sendVerificationEmail).mockResolvedValue();
  });

  it('有効な入力でユーザを作成する（パスワードなし、リカバリーコードなし）', async () => {
    const result = await createUser(validInput, creatorId, {
      baseUrl: 'https://example.com',
      tenantId: DEFAULT_TEST_TENANT_ID,
    });

    expect(result.user.name).toBe(validInput.name);
    expect(result.user.email).toBe(validInput.email);
    expect(result.user.isActive).toBe(false);
    expect(prisma.user.create).toHaveBeenCalledOnce();
    expect(prisma.roleChangeLog.create).toHaveBeenCalledOnce();
  });

  // ★severity-1 regression (fix/tenant-id-default-removal, 2026-05-28):
  //   schema の `@default(dbgenerated tenantId)` 撤去後、createUser が必ず指定 tenantId で
  //   保存することを保証する。本テストが緑であることが「Default テナント silent 混入」
  //   再発防止の最終ガード。
  it('★severity-1 regression: 指定 tenantId が prisma.user.create に data として渡される', async () => {
    await createUser(validInput, creatorId, {
      baseUrl: 'https://example.com',
      tenantId: 'tenant-X-uuid',
    });
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant-X-uuid' }),
      }),
    );
  });

  it('招待メールを送信する', async () => {
    await createUser(validInput, creatorId, {
      baseUrl: 'https://example.com',
      tenantId: DEFAULT_TEST_TENANT_ID,
    });

    expect(sendVerificationEmail).toHaveBeenCalledWith(
      'new-user-id',
      'tenant-A',
      validInput.email,
      'https://example.com',
    );
  });

  it('既に有効なユーザが存在する場合は DUPLICATE_EMAIL エラー', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({
      id: 'existing-id',
      deletedAt: null,
    } as never);

    await expect(
      createUser(validInput, creatorId, { tenantId: DEFAULT_TEST_TENANT_ID }),
    ).rejects.toThrow('DUPLICATE_EMAIL');
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

    const result = await createUser(validInput, creatorId, {
      baseUrl: 'https://example.com',
      tenantId: DEFAULT_TEST_TENANT_ID,
    });

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(result.user.email).toBe(validInput.email);
  });

  it('メール送信失敗時はユーザをロールバックして EMAIL_SEND_FAILED エラー', async () => {
    vi.mocked(sendVerificationEmail).mockRejectedValue(
      new EmailSendError('送信失敗'),
    );

    await expect(
      createUser(validInput, creatorId, {
        baseUrl: 'https://example.com',
        tenantId: DEFAULT_TEST_TENANT_ID,
      }),
    ).rejects.toThrow('EMAIL_SEND_FAILED');

    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('baseUrl 未指定の場合はメール送信をスキップする', async () => {
    await createUser(validInput, creatorId, { tenantId: DEFAULT_TEST_TENANT_ID });

    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  // P-2 (2026-05-08): Beginner プラン席数上限の API 層 enforce
  describe('P-2: Beginner プラン席数上限 enforce', () => {
    const tenantId = 'tenant-uuid';

    it('Beginner プランで席数に余裕があれば作成成功 (4 / 5 → 5 で OK)', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
        plan: 'beginner',
        beginnerMaxSeats: 5,
      } as never);
      vi.mocked(prisma.user.count).mockResolvedValueOnce(4);

      const result = await createUser(validInput, creatorId, {
        baseUrl: 'https://example.com',
        tenantId,
      });

      expect(result.user.email).toBe(validInput.email);
      expect(prisma.user.create).toHaveBeenCalled();
    });

    it('Beginner プランで席数上限に達している場合は SEAT_LIMIT_EXCEEDED エラー (5 / 5 → 6 で拒否)', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
        plan: 'beginner',
        beginnerMaxSeats: 5,
      } as never);
      vi.mocked(prisma.user.count).mockResolvedValueOnce(5);

      await expect(
        createUser(validInput, creatorId, {
          baseUrl: 'https://example.com',
          tenantId,
        }),
      ).rejects.toThrow('SEAT_LIMIT_EXCEEDED');

      // 席数チェックで弾かれるため、user.create は呼ばれない
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('Beginner プランで席数を超過している場合も SEAT_LIMIT_EXCEEDED エラー (6 / 5 → 7 で拒否)', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
        plan: 'beginner',
        beginnerMaxSeats: 5,
      } as never);
      vi.mocked(prisma.user.count).mockResolvedValueOnce(6);

      await expect(
        createUser(validInput, creatorId, {
          baseUrl: 'https://example.com',
          tenantId,
        }),
      ).rejects.toThrow('SEAT_LIMIT_EXCEEDED');
    });

    it('Expert プランは無制限 (席数チェックを実施しない)', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
        plan: 'expert',
        beginnerMaxSeats: 5,
      } as never);

      const result = await createUser(validInput, creatorId, {
        baseUrl: 'https://example.com',
        tenantId,
      });

      expect(result.user.email).toBe(validInput.email);
      // user.count は呼ばれない (Expert は plan チェックの時点で短絡)
      expect(prisma.user.count).not.toHaveBeenCalled();
    });

    it('Pro プランは無制限 (席数チェックを実施しない)', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
        plan: 'pro',
        beginnerMaxSeats: 5,
      } as never);

      const result = await createUser(validInput, creatorId, {
        baseUrl: 'https://example.com',
        tenantId,
      });

      expect(result.user.email).toBe(validInput.email);
      expect(prisma.user.count).not.toHaveBeenCalled();
    });

    it('テナント不在 (DB から消えた) なら席数チェックをスキップ (他経路で 404 になる前提)', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce(null);

      // 席数エラーは投げず、後続の DUPLICATE_EMAIL チェックや user.create に進む
      const result = await createUser(validInput, creatorId, {
        baseUrl: 'https://example.com',
        tenantId,
      });

      expect(result.user.email).toBe(validInput.email);
    });
  });
});

describe('assertSeatAvailableForTenant (P-2 / 2026-05-08)', () => {
  beforeEach(() => vi.clearAllMocks());

  const tenantId = 'tenant-uuid';

  it('Beginner で空き席ありなら例外を投げない', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
      plan: 'beginner',
      beginnerMaxSeats: 5,
    } as never);
    vi.mocked(prisma.user.count).mockResolvedValueOnce(3);

    await expect(assertSeatAvailableForTenant(tenantId)).resolves.toBeUndefined();
  });

  it('Beginner で席数上限ちょうどなら SEAT_LIMIT_EXCEEDED', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
      plan: 'beginner',
      beginnerMaxSeats: 5,
    } as never);
    vi.mocked(prisma.user.count).mockResolvedValueOnce(5);

    await expect(assertSeatAvailableForTenant(tenantId)).rejects.toThrow('SEAT_LIMIT_EXCEEDED');
  });

  it('Beginner で席数上限超過なら SEAT_LIMIT_EXCEEDED', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
      plan: 'beginner',
      beginnerMaxSeats: 5,
    } as never);
    vi.mocked(prisma.user.count).mockResolvedValueOnce(6);

    await expect(assertSeatAvailableForTenant(tenantId)).rejects.toThrow('SEAT_LIMIT_EXCEEDED');
  });

  it('beginnerMaxSeats が 5 以外でもその値で判定する (将来 plan 変更想定)', async () => {
    // beginnerMaxSeats = 3 で 3 人在籍 → 4 人目は拒否
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
      plan: 'beginner',
      beginnerMaxSeats: 3,
    } as never);
    vi.mocked(prisma.user.count).mockResolvedValueOnce(3);

    await expect(assertSeatAvailableForTenant(tenantId)).rejects.toThrow('SEAT_LIMIT_EXCEEDED');
  });

  it('Expert / Pro は無制限なので user.count が呼ばれない', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
      plan: 'expert',
      beginnerMaxSeats: 5,
    } as never);

    await assertSeatAvailableForTenant(tenantId);
    expect(prisma.user.count).not.toHaveBeenCalled();

    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
      plan: 'pro',
      beginnerMaxSeats: 5,
    } as never);

    await assertSeatAvailableForTenant(tenantId);
    expect(prisma.user.count).not.toHaveBeenCalled();
  });

  it('テナント不在ならスキップ (他経路で 404 を返す前提)', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce(null);

    await expect(assertSeatAvailableForTenant(tenantId)).resolves.toBeUndefined();
    expect(prisma.user.count).not.toHaveBeenCalled();
  });

  it('isActive=false および deletedAt!=null は席数カウント対象外 (tenant-self.service と統一)', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
      plan: 'beginner',
      beginnerMaxSeats: 5,
    } as never);
    vi.mocked(prisma.user.count).mockResolvedValueOnce(2);

    await assertSeatAvailableForTenant(tenantId);

    // count の where 句に isActive: true, deletedAt: null が含まれることを確認
    expect(prisma.user.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId,
          isActive: true,
          deletedAt: null,
        }),
      }),
    );
  });
});

const baseUserRow = {
  id: 'u-1',
  // Phase 2-10: tenantId 必須化対応 (deleteUser 等で参照される)
  tenantId: 'tenant-A',
  name: 'Alice',
  email: 'a@b.co',
  systemRole: 'general',
  isActive: true,
  createdAt: new Date('2026-04-01'),
  updatedAt: new Date('2026-04-01'),
  // PR #85 / T-21: ロック情報 (UserDTO 拡張)
  failedLoginCount: 0,
  lockedUntil: null as Date | null,
  permanentLock: false,
  temporaryLockCount: 0,
};

describe('listUsers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('削除済みを除外し自テナント限定で DTO を返す', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([baseUserRow] as never);

    const r = await listUsers('tenant-A');

    expect(r[0].id).toBe('u-1');
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null, tenantId: 'tenant-A' } }),
    );
  });

  it('テナント越境フィルタで他テナント user は返さない (severity-1 防御)', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);
    await listUsers('tenant-A');
    const call = vi.mocked(prisma.user.findMany).mock.calls[0][0];
    expect((call.where as { tenantId: string }).tenantId).toBe('tenant-A');
  });
});

describe('updateUserStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('有効化 → before=inactive / after=active の監査ログ', async () => {
    // 2026-05-09 feedback Phase 2-6: 所有確認用 mock
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'u-1' } as never);
    vi.mocked(prisma.user.update).mockResolvedValue(baseUserRow as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    await updateUserStatus('u-1', true, 'admin-1', 'tenant-A');

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
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'u-1' } as never);
    vi.mocked(prisma.user.update).mockResolvedValue(baseUserRow as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    await updateUserStatus('u-1', false, 'admin-1', 'tenant-A');

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
    await expect(updateUserRole('same-id', 'admin', 'same-id', 'tenant-A')).rejects.toThrow(
      'CANNOT_CHANGE_OWN_ROLE',
    );
  });

  it('対象ユーザ不在で NOT_FOUND', async () => {
    // 2026-05-09 feedback Phase 2-6: findUnique → findFirst (tenantId 検証付き)
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    await expect(updateUserRole('u-1', 'admin', 'admin-1', 'tenant-A')).rejects.toThrow('NOT_FOUND');
  });

  it('ロール更新 + 監査ログ記録', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      ...baseUserRow,
      systemRole: 'general',
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      ...baseUserRow,
      systemRole: 'admin',
    } as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    const r = await updateUserRole('u-1', 'admin', 'admin-1', 'tenant-A');

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
    // 2026-05-09 feedback Phase 2-6: updateUser 冒頭の所有確認用 mock
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'u-1' } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      ...baseUserRow,
      name: 'New',
    } as never);

    const r = await updateUser('u-1', { name: 'New' }, 'admin-1', 'tenant-A');

    expect(r.name).toBe('New');
    expect(prisma.roleChangeLog.create).not.toHaveBeenCalled();
  });

  it('systemRole 指定時は updateUserRole 経路', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      ...baseUserRow,
      systemRole: 'general',
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      ...baseUserRow,
      systemRole: 'admin',
    } as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    await updateUser('u-1', { systemRole: 'admin' }, 'admin-1', 'tenant-A');

    expect(prisma.roleChangeLog.create).toHaveBeenCalled();
  });

  it('isActive 指定時は updateUserStatus 経路', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'u-1' } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      ...baseUserRow,
      isActive: false,
    } as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    await updateUser('u-1', { isActive: false }, 'admin-1', 'tenant-A');

    expect(prisma.roleChangeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ afterRole: 'inactive' }),
      }),
    );
  });

  it('空入力時は findUniqueOrThrow で現在値を返す', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'u-1' } as never);
    vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue(baseUserRow as never);

    const r = await updateUser('u-1', {}, 'admin-1', 'tenant-A');

    expect(r.id).toBe('u-1');
    expect(prisma.roleChangeLog.create).not.toHaveBeenCalled();
  });
});

describe('deleteUser (PR #89)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('自分自身の削除は CANNOT_DELETE_SELF', async () => {
    await expect(deleteUser('same-id', 'same-id', 'tenant-A')).rejects.toThrow('CANNOT_DELETE_SELF');
  });

  it('対象ユーザ不在で NOT_FOUND', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    await expect(deleteUser('u-1', 'admin-1', 'tenant-A')).rejects.toThrow('NOT_FOUND');
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

    const r = await deleteUser('u-1', 'admin-1', 'tenant-A');

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

    await deleteUser('u-1', 'admin-1', 'tenant-A');

    // Memo.deleteMany が userId=u-1 + tenantId 二重防御で 1 回呼ばれたこと (Phase 2-10)
    expect(prisma.memo.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u-1', tenantId: 'tenant-A' } });
    expect(prisma.memo.deleteMany).toHaveBeenCalledTimes(1);
  });

  // feat/crud-permission-redesign (2026-05-20, 2 巡目検証 Test-G2): membership あり時の
  //   roleChangeLog.createMany 呼出を検証 (PM/TL ユーザ削除時の解除履歴記録の回帰防止)
  it('membership あり時に roleChangeLog.createMany で project_role 解除が記録される', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(baseUserRow as never);
    // 削除対象が 2 つの projectMember を保有
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([
      { id: 'pm-1', projectId: 'p-1', projectRole: 'pm_tl' },
      { id: 'pm-2', projectId: 'p-2', projectRole: 'member' },
    ] as never);
    vi.mocked(prisma.projectMember.deleteMany).mockResolvedValue({ count: 2 } as never);
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.recoveryCode.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.emailVerificationToken.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.passwordResetToken.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.passwordHistory.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.memo.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);
    vi.mocked(prisma.roleChangeLog.createMany).mockResolvedValue({ count: 2 } as never);

    await deleteUser('u-1', 'admin-1', 'tenant-A');

    // bulk createMany で project_role 解除が 2 件記録された
    expect(prisma.roleChangeLog.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            tenantId: 'tenant-A',
            changedBy: 'admin-1',
            targetUserId: 'u-1',
            changeType: 'project_role',
            projectId: 'p-1',
            beforeRole: 'pm_tl',
            afterRole: 'removed',
          }),
          expect.objectContaining({
            projectId: 'p-2',
            beforeRole: 'member',
            afterRole: 'removed',
          }),
        ]),
      }),
    );
  });

  it('membership 0 件時は roleChangeLog.createMany は呼ばれない (空配列 createMany 回避)', async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(baseUserRow as never);
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([]);
    vi.mocked(prisma.projectMember.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.recoveryCode.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.emailVerificationToken.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.passwordResetToken.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.passwordHistory.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.memo.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
    vi.mocked(prisma.roleChangeLog.create).mockResolvedValue({} as never);

    await deleteUser('u-1', 'admin-1', 'tenant-A');

    expect(prisma.roleChangeLog.createMany).not.toHaveBeenCalled();
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

  // 2026-05-12 severity-1 防御テスト
  describe('★テナント越境防止★ tenantScope 引数', () => {
    it('tenantScope 省略 (cron 経路) は全テナント横断 (where に tenantId フィルタなし)', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);

      await lockInactiveUsers('cron-trigger');

      const findCall = vi.mocked(prisma.user.findMany).mock.calls[0][0];
      // 全テナント横断 = where に tenantId プロパティが存在しない
      expect((findCall?.where as Record<string, unknown> | undefined)?.tenantId).toBeUndefined();
    });

    it('tenantScope 指定 (manual 経路) は自テナント内のみに限定', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);

      await lockInactiveUsers('admin-from-tenant-A', 'tenant-A-id');

      const findCall = vi.mocked(prisma.user.findMany).mock.calls[0][0];
      // 自テナント内のみ = where.tenantId が指定されている
      expect((findCall?.where as Record<string, unknown>)?.tenantId).toBe('tenant-A-id');
    });

    it('tenantScope=tenant-A の場合、tenant-B のユーザは抽出対象外 (越境ロック遮断)', async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([
        { id: 'u-tenant-a-stale', name: 'A', email: 'a@a.com', tenantId: 'tenant-A-id' },
      ] as never);
      vi.mocked(prisma.user.update).mockResolvedValue({} as never);
      vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);

      const r = await lockInactiveUsers('admin-from-tenant-A', 'tenant-A-id');

      // findMany の where に tenantId='tenant-A-id' が必ず含まれる → tenant-B 越境不可
      const findCall = vi.mocked(prisma.user.findMany).mock.calls[0][0];
      expect((findCall?.where as Record<string, unknown>)?.tenantId).toBe('tenant-A-id');
      // 1 件のみ抽出された
      expect(r.lockedUserIds).toEqual(['u-tenant-a-stale']);
    });
  });
});
