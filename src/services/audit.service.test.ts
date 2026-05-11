import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      tenantId: 'tenant-A',
      userId: 'u-1',
      action: 'CREATE',
      entityType: 'project',
      entityId: 'p-1',
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-A',
        userId: 'u-1',
        action: 'CREATE',
        entityType: 'project',
        entityId: 'p-1',
      }),
    });
  });

  it('before/after 値と ipAddress を記録する', async () => {
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);

    await recordAuditLog({
      tenantId: 'tenant-A',
      userId: 'u-1',
      action: 'UPDATE',
      entityType: 'project',
      entityId: 'p-1',
      beforeValue: { name: 'old' },
      afterValue: { name: 'new' },
      ipAddress: '10.0.0.1',
    });

    const call = vi.mocked(prisma.auditLog.create).mock.calls[0][0];
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
      tenantId: 'tenant-customer-X',
      userId: 'u-1',
      action: 'CREATE',
      entityType: 'project',
      entityId: 'p-1',
    });

    // data.tenantId が必ずセットされている (= DB DEFAULT 暗黙依存していない) ことの保証
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0][0];
    expect(call.data).toHaveProperty('tenantId', 'tenant-customer-X');
  });

  it('★越境テスト★ super_admin が他テナントを操作する場合、target tenant の ID が記録されること', async () => {
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);

    // ケース: super_admin (management tenant 所属) がテナント X を代行 export
    await recordAuditLog({
      tenantId: 'tenant-customer-X', // ← actor の tenant ではなく target の tenant
      userId: 'super-admin-user-id',
      action: 'EXPORT',
      entityType: 'tenant',
      entityId: 'tenant-customer-X',
    });

    const call = vi.mocked(prisma.auditLog.create).mock.calls[0][0];
    expect(call.data.tenantId).toBe('tenant-customer-X');
    // → このログは customer-X の admin が監査ログ画面で見られる (target tenant 視点で記録されるため)
  });
});

describe('recordBulkAuditLogs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('entityIds が空なら createMany を呼ばない (no-op)', async () => {
    await recordBulkAuditLogs({
      tenantId: 'tenant-A',
      userId: 'u-1',
      action: 'UPDATE',
      entityType: 'task',
      entityIds: [],
    });

    expect(prisma.auditLog.createMany).not.toHaveBeenCalled();
  });

  it('各 entityId に 1 行ずつ createMany する', async () => {
    vi.mocked(prisma.auditLog.createMany).mockResolvedValue({ count: 3 } as never);

    await recordBulkAuditLogs({
      tenantId: 'tenant-A',
      userId: 'u-1',
      action: 'UPDATE',
      entityType: 'task',
      entityIds: ['a', 'b', 'c'],
      afterValue: { bulk: true, batchSize: 3 },
    });

    const call = vi.mocked(prisma.auditLog.createMany).mock.calls[0][0];
    expect(call.data).toHaveLength(3);
    expect(call.data[0].entityId).toBe('a');
    expect(call.data[2].entityId).toBe('c');
    expect(call.data[0].afterValue).toEqual({ bulk: true, batchSize: 3 });
  });

  it('★Phase 2-10 リグレッション防止★ 全行に tenantId が乗ること (createMany でも省略不可)', async () => {
    vi.mocked(prisma.auditLog.createMany).mockResolvedValue({ count: 3 } as never);

    await recordBulkAuditLogs({
      tenantId: 'tenant-customer-X',
      userId: 'u-1',
      action: 'UPDATE',
      entityType: 'task',
      entityIds: ['t-1', 't-2', 't-3'],
    });

    const call = vi.mocked(prisma.auditLog.createMany).mock.calls[0][0];
    expect(call.data).toHaveLength(3);
    // すべての行に tenantId が乗っていること
    for (const row of call.data) {
      expect(row.tenantId).toBe('tenant-customer-X');
    }
  });
});
