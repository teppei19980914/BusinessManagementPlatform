import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    auditLog: {
      create: vi.fn(),
      createMany: vi.fn(),
    },
  },
}));

import { sanitizeForAudit, recordAuditLog, recordBulkAuditLogs } from './audit.service';
import { prisma } from '@/lib/db';
import { getMockCallArg } from '@/lib/test-mock-helpers';

// PR-V8 (2026-05-19): UUID guard 追加に伴い、test 用 UUID を定数化
const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_X = '00000000-0000-0000-0000-00000000000c'; // customer-X
const USER_1 = '00000000-0000-0000-0000-000000000001';
const SUPER_ADMIN_USER = '00000000-0000-0000-0000-0000000000aa';
const PROJECT_1 = '00000000-0000-0000-0000-000000000101';
const TASK_1 = '00000000-0000-0000-0000-000000000201';
const TASK_2 = '00000000-0000-0000-0000-000000000202';
const TASK_3 = '00000000-0000-0000-0000-000000000203';

describe('sanitizeForAudit', () => {
  it('passwordHash を [REDACTED] に置換する', () => {
    const result = sanitizeForAudit({
      id: '123',
      name: 'test',
      passwordHash: '$2a$12$xxxxx',
    });
    expect(result.passwordHash).toBe('[REDACTED]');
    expect(result.id).toBe('123');
    expect(result.name).toBe('test');
  });

  it('password_hash（スネークケース）も [REDACTED] に置換する', () => {
    const result = sanitizeForAudit({
      id: '123',
      password_hash: '$2a$12$xxxxx',
    });
    expect(result.password_hash).toBe('[REDACTED]');
  });

  it('mfaSecretEncrypted を [REDACTED] に置換する', () => {
    const result = sanitizeForAudit({
      id: '123',
      mfaSecretEncrypted: 'encrypted-secret',
    });
    expect(result.mfaSecretEncrypted).toBe('[REDACTED]');
  });

  it('mfa_secret_encrypted（スネークケース）も [REDACTED] に置換する', () => {
    const result = sanitizeForAudit({
      id: '123',
      mfa_secret_encrypted: 'encrypted-secret',
    });
    expect(result.mfa_secret_encrypted).toBe('[REDACTED]');
  });

  it('機密フィールドがない場合はそのまま返す', () => {
    const input = { id: '123', name: 'test', email: 'test@example.com' };
    const result = sanitizeForAudit(input);
    expect(result).toEqual(input);
  });

  it('空のオブジェクトを処理できる', () => {
    const result = sanitizeForAudit({});
    expect(result).toEqual({});
  });

  it('元のオブジェクトを変更しない', () => {
    const input = { id: '123', passwordHash: 'secret' };
    sanitizeForAudit(input);
    expect(input.passwordHash).toBe('secret');
  });
});

describe('recordAuditLog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('最小構成 (tenantId / userId / action / entityType / entityId) で記録できる', async () => {
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);

    await recordAuditLog({
      tenantId: TENANT_A,
      userId: USER_1,
      action: 'CREATE',
      entityType: 'project',
      entityId: PROJECT_1,
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_A,
        userId: USER_1,
        action: 'CREATE',
        entityType: 'project',
        entityId: PROJECT_1,
      }),
    });
  });

  it('before/after 値と ipAddress を記録する', async () => {
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);

    await recordAuditLog({
      tenantId: TENANT_A,
      userId: USER_1,
      action: 'UPDATE',
      entityType: 'project',
      entityId: PROJECT_1,
      beforeValue: { name: 'old' },
      afterValue: { name: 'new' },
      ipAddress: '10.0.0.1',
    });

    const call = getMockCallArg(vi.mocked(prisma.auditLog.create));
    expect(call.data.beforeValue).toEqual({ name: 'old' });
    expect(call.data.afterValue).toEqual({ name: 'new' });
    expect(call.data.ipAddress).toBe('10.0.0.1');
  });

  // ==========================================================================
  // Phase 2-10 (2026-05-10): tenantId 必須化のリグレッション防止
  // 本テストは将来も絶対に通り続けることが、admin 監査画面の越境遮断 (severity-1) を保証する。
  // ==========================================================================

  it('★Phase 2-10 リグレッション防止★ tenantId は data に常に含まれること (越境ログ汚染防止)', async () => {
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);

    await recordAuditLog({
      tenantId: TENANT_X,
      userId: USER_1,
      action: 'CREATE',
      entityType: 'project',
      entityId: PROJECT_1,
    });

    // data.tenantId が必ずセットされている (= DB DEFAULT 暗黙依存していない) ことの保証
    const call = getMockCallArg(vi.mocked(prisma.auditLog.create));
    expect(call.data).toHaveProperty('tenantId', TENANT_X);
  });

  it('★越境テスト★ super_admin が他テナントを操作する場合、target tenant の ID が記録されること', async () => {
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);

    // ケース: super_admin (management tenant 所属) がテナント X を代行 export
    await recordAuditLog({
      tenantId: TENANT_X, // ← actor の tenant ではなく target の tenant
      userId: SUPER_ADMIN_USER,
      action: 'EXPORT',
      entityType: 'tenant',
      entityId: TENANT_X,
    });

    const call = getMockCallArg(vi.mocked(prisma.auditLog.create));
    expect(call.data.tenantId).toBe(TENANT_X);
    // → このログは customer-X の admin が監査ログ画面で見られる (target tenant 視点で記録されるため)
  });

  // ==========================================================================
  // PR-V8 (2026-05-19): UUID guard 追加 ─ 本件 (recalculate-all の entityId='all-tenants') の
  //   silent fail を未然に防ぐ。
  //
  // 注: test 環境 (NODE_ENV='test') は既存 test 互換のため warn にとどまる。
  //   guard 自体の動作検証は STRICT_AUDIT_UUID=true を上書きして強制 strict 化する。
  // ==========================================================================

  describe('UUID guard (STRICT_AUDIT_UUID=true で本番動作を模倣)', () => {
    let originalStrict: string | undefined;
    beforeEach(() => {
      originalStrict = process.env['STRICT_AUDIT_UUID'];
      process.env['STRICT_AUDIT_UUID'] = 'true';
    });
    afterEach(() => {
      if (originalStrict === undefined) delete process.env['STRICT_AUDIT_UUID'];
      else process.env['STRICT_AUDIT_UUID'] = originalStrict;
    });

    it('★PR-V8 UUID guard★ entityId が非 UUID なら throw (silent fail 防止)', async () => {
      await expect(
        recordAuditLog({
          tenantId: TENANT_A,
          userId: USER_1,
          action: 'UPDATE',
          entityType: 'system',
          entityId: 'all-tenants', // ← 本件で silent fail していた合成キー
        }),
      ).rejects.toThrow(/entityId/);
      // prisma.auditLog.create は呼ばれない (= service 入口で弾く)
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('★PR-V8 UUID guard★ tenantId が非 UUID なら throw', async () => {
      await expect(
        recordAuditLog({
          tenantId: 'invalid-tenant',
          userId: USER_1,
          action: 'CREATE',
          entityType: 'project',
          entityId: PROJECT_1,
        }),
      ).rejects.toThrow(/tenantId/);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('★PR-V8 UUID guard★ userId が非 UUID なら throw', async () => {
      await expect(
        recordAuditLog({
          tenantId: TENANT_A,
          userId: 'system',
          action: 'CREATE',
          entityType: 'project',
          entityId: PROJECT_1,
        }),
      ).rejects.toThrow(/userId/);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('★PR-V8 UUID guard★ "bulk:24" のような合成文字列は entityId として拒否', async () => {
      await expect(
        recordAuditLog({
          tenantId: TENANT_A,
          userId: USER_1,
          action: 'SYNC_IMPORT',
          entityType: 'task',
          entityId: 'bulk:24',
        }),
      ).rejects.toThrow(/entityId/);
    });
  });
});

describe('recordBulkAuditLogs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('entityIds が空なら createMany を呼ばない (no-op)', async () => {
    await recordBulkAuditLogs({
      tenantId: TENANT_A,
      userId: USER_1,
      action: 'UPDATE',
      entityType: 'task',
      entityIds: [],
    });

    expect(prisma.auditLog.createMany).not.toHaveBeenCalled();
  });

  it('各 entityId に 1 行ずつ createMany する', async () => {
    vi.mocked(prisma.auditLog.createMany).mockResolvedValue({ count: 3 } as never);

    await recordBulkAuditLogs({
      tenantId: TENANT_A,
      userId: USER_1,
      action: 'UPDATE',
      entityType: 'task',
      entityIds: [TASK_1, TASK_2, TASK_3],
      afterValue: { bulk: true, batchSize: 3 },
    });

    const call = getMockCallArg(vi.mocked(prisma.auditLog.createMany));
    expect(call.data).toHaveLength(3);
    expect(call.data[0].entityId).toBe(TASK_1);
    expect(call.data[2].entityId).toBe(TASK_3);
    expect(call.data[0].afterValue).toEqual({ bulk: true, batchSize: 3 });
  });

  it('★Phase 2-10 リグレッション防止★ 全行に tenantId が乗ること (createMany でも省略不可)', async () => {
    vi.mocked(prisma.auditLog.createMany).mockResolvedValue({ count: 3 } as never);

    await recordBulkAuditLogs({
      tenantId: TENANT_X,
      userId: USER_1,
      action: 'UPDATE',
      entityType: 'task',
      entityIds: [TASK_1, TASK_2, TASK_3],
    });

    const call = getMockCallArg(vi.mocked(prisma.auditLog.createMany));
    expect(call.data).toHaveLength(3);
    // すべての行に tenantId が乗っていること
    for (const row of call.data) {
      expect(row.tenantId).toBe(TENANT_X);
    }
  });

  describe('UUID guard (STRICT_AUDIT_UUID=true)', () => {
    let originalStrict: string | undefined;
    beforeEach(() => {
      originalStrict = process.env['STRICT_AUDIT_UUID'];
      process.env['STRICT_AUDIT_UUID'] = 'true';
    });
    afterEach(() => {
      if (originalStrict === undefined) delete process.env['STRICT_AUDIT_UUID'];
      else process.env['STRICT_AUDIT_UUID'] = originalStrict;
    });

    it('★PR-V8 UUID guard★ entityIds に非 UUID が含まれていたら throw', async () => {
      await expect(
        recordBulkAuditLogs({
          tenantId: TENANT_A,
          userId: USER_1,
          action: 'UPDATE',
          entityType: 'task',
          entityIds: [TASK_1, 'invalid-id', TASK_3],
        }),
      ).rejects.toThrow(/entityId/);
      expect(prisma.auditLog.createMany).not.toHaveBeenCalled();
    });
  });
});
