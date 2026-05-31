import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    // ADR-0016 (2026-05-20): tenant.findFirst (slug → id 解決) を追加 mock
    tenant: { findFirst: vi.fn() },
    user: { findFirst: vi.fn(), update: vi.fn() },
    // Phase 2-10: tenantId 併記の二重防御で updateMany を使う
    recoveryCode: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
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

  // ADR-0016 (2026-05-20): tenant.findFirst を共通 mock (slug → id 解決)
  const mockTenantFound = () =>
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({ id: 'tenant-A' } as never);

  it('テナント不在の場合は汎用エラー (テナント存在漏洩防止)', async () => {
    // ADR-0016: tenantSlug が存在しない場合のテストケース
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(null);

    const res = await verifyAndIssueResetToken('a@b.co', 'code', 'nonexistent-tenant');

    expect(res.success).toBe(false);
    expect(res.error).toContain('正しくありません');
  });

  it('ユーザ不在の場合は汎用エラー (ユーザ存在漏洩防止)', async () => {
    mockTenantFound();
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

    const res = await verifyAndIssueResetToken('nobody@example.com', 'code', 'tenant-a');

    expect(res.success).toBe(false);
    expect(res.error).toContain('正しくありません');
  });

  it('リカバリーコード不一致は汎用エラー + 監査ログ', async () => {
    mockTenantFound();
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'u1', tenantId: 'tenant-A' } as never);
    vi.mocked(prisma.recoveryCode.findMany).mockResolvedValue([
      { id: 'c1', codeHash: 'h1' },
    ] as never);
    vi.mocked(compare).mockResolvedValue(false as never);

    const res = await verifyAndIssueResetToken('a@b.co', 'wrongcode', 'tenant-a');

    expect(res.success).toBe(false);
    expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
  });

  it('成功: リカバリーコード使用済みマーク + トークン発行', async () => {
    mockTenantFound();
    // Phase 2-10: user.findFirst 結果に tenantId を含める (recoveryCode 系の where に使用)
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'u1', tenantId: 'tenant-A' } as never);
    vi.mocked(prisma.recoveryCode.findMany).mockResolvedValue([
      { id: 'c1', codeHash: 'h1' },
    ] as never);
    vi.mocked(compare).mockResolvedValueOnce(true as never);
    // Phase 2-10: updateMany で tenantId 二重防御
    vi.mocked(prisma.recoveryCode.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.passwordResetToken.create).mockResolvedValue({} as never);

    const res = await verifyAndIssueResetToken('a@b.co', 'goodcode', 'tenant-a');

    expect(res.success).toBe(true);
    expect(res.token).toMatch(/^[a-f0-9]{64}$/);
    expect(prisma.recoveryCode.updateMany).toHaveBeenCalled();
    expect(prisma.passwordResetToken.create).toHaveBeenCalled();
  });
});

describe('resetPassword', () => {
  beforeEach(() => vi.clearAllMocks());

  it('トークンが無効なら 無効なリンク エラー', async () => {
    vi.mocked(prisma.passwordResetToken.findFirst).mockResolvedValue(null);

    const res = await resetPassword('any', 'newpass', 'org-1');

    expect(res.success).toBe(false);
    expect(res.error).toContain('無効');
  });

  it('既に使用済みなら エラー', async () => {
    vi.mocked(prisma.passwordResetToken.findFirst).mockResolvedValue({
      id: 't1',
      userId: 'u1',
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
      // security/phase-3 (2026-05-31): tenant 二重検証
      tenant: { slug: 'org-1' },
    } as never);

    const res = await resetPassword('any', 'newpass', 'org-1');

    expect(res.success).toBe(false);
    expect(res.error).toContain('使用');
  });

  it('期限切れなら エラー', async () => {
    vi.mocked(prisma.passwordResetToken.findFirst).mockResolvedValue({
      id: 't1',
      userId: 'u1',
      usedAt: null,
      expiresAt: new Date(Date.now() - 60000),
      tenant: { slug: 'org-1' },
    } as never);

    const res = await resetPassword('any', 'newpass', 'org-1');

    expect(res.success).toBe(false);
    expect(res.error).toContain('有効期限');
  });

  it('履歴再利用なら エラー (トランザクションには進まない)', async () => {
    vi.mocked(prisma.passwordResetToken.findFirst).mockResolvedValue({
      id: 't1',
      userId: 'u1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60000),
      tenant: { slug: 'org-1' },
    } as never);
    vi.mocked(prisma.passwordHistory.findMany).mockResolvedValue([
      { passwordHash: 'h_old' },
    ] as never);
    vi.mocked(compare).mockResolvedValueOnce(true as never);

    const res = await resetPassword('any', 'reused', 'org-1');

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
      tenantId: 'tenant-A',
      tenant: { slug: 'org-1' },
    } as never);
    vi.mocked(prisma.passwordHistory.findMany).mockResolvedValue([]);

    const res = await resetPassword('any', 'brandnew', 'org-1');

    expect(res.success).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  // security/phase-3 (2026-05-31): tenant 二重検証の効果テスト
  it('tenantSlug が token 発行時の tenant と一致しないと「無効なリンク」', async () => {
    vi.mocked(prisma.passwordResetToken.findFirst).mockResolvedValue({
      id: 't1',
      userId: 'u1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60000),
      tenant: { slug: 'org-A' }, // 発行時 tenant
    } as never);

    // 別 tenant 名で叩く (= multi-tenant 越境攻撃シナリオ)
    const res = await resetPassword('any', 'brandnew', 'org-B');

    expect(res.success).toBe(false);
    expect(res.error).toContain('無効');
    expect(prisma.passwordHistory.findMany).not.toHaveBeenCalled();
  });
});
