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

  it('最小構成 (userId / action / entityType / entityId) で記録できる', async () => {
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);

    await recordAuditLog({
      userId: 'u-1',
      action: 'CREATE',
      entityType: 'project',
      entityId: 'p-1',
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
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
});

describe('recordBulkAuditLogs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('entityIds が空なら createMany を呼ばない (no-op)', async () => {
    await recordBulkAuditLogs({
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
});
