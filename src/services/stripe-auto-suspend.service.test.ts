/**
 * stripe-auto-suspend.service の単体テスト (PR-S6 / 2026-05-14)
 *
 * 検証観点:
 *   1. 候補ゼロ件: 0 件で返却
 *   2. 成功時: suspendTenant 呼出 + autoSuspendScheduledAt クリア
 *   3. ALREADY_SUSPENDED / TENANT_DELETED / MANAGEMENT_TENANT_FORBIDDEN → skip カウンタ
 *   4. それ以外のエラー → errors に追加 (= 全体は止まらない)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Prisma モック
vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

// stripe lib モック (getSystemUserId / isStripeEnabled)
// 2026-05-18 (fix/cron-public-paths-and-stripe-disabled-guard):
//   既存テストは Stripe 有効 (= isStripeEnabled=true) 前提で動作確認しているので default は true。
//   Stripe 無効時の no-op 挙動は専用 describe ブロックで isStripeEnabledMock を false に切替えて検証。
const isStripeEnabledMock = vi.fn(() => true);
vi.mock('@/lib/stripe', () => ({
  getSystemUserId: () => 'system-user-uuid',
  isStripeEnabled: () => isStripeEnabledMock(),
}));

// super-admin.service モック (suspendTenant)
const mockSuspendTenant = vi.fn();
vi.mock('./super-admin.service', () => ({
  suspendTenant: (tenantId: string, reason: string, performerId: string) =>
    mockSuspendTenant(tenantId, reason, performerId),
}));

import { prisma } from '@/lib/db';
import { autoSuspendDelinquentTenants } from './stripe-auto-suspend.service';

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

beforeEach(() => {
  vi.clearAllMocks();
  // 既存テストは Stripe 有効前提なので明示的に true に戻す
  isStripeEnabledMock.mockReturnValue(true);
});

describe('autoSuspendDelinquentTenants', () => {
  it('候補ゼロ件なら 0 件で返却', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([] as never);
    const result = await autoSuspendDelinquentTenants();
    expect(result).toEqual({
      candidates: 0,
      suspended: 0,
      skipped: 0,
      errors: [],
    });
  });

  // 2026-05-18 (fix/cron-public-paths-and-stripe-disabled-guard):
  //   Netlify 環境で STRIPE_ENABLED 未設定 + SYSTEM_USER_ID 未設定だと cron が 500 になっていた。
  //   兄弟関数 `flushStripeUsageRecordQueue` と整合性を取り、Stripe 無効時は no-op で早期 return する。
  it('STRIPE_ENABLED=false なら DB に触れず skippedStripeDisabled=true で返却', async () => {
    isStripeEnabledMock.mockReturnValue(false);

    const result = await autoSuspendDelinquentTenants();

    expect(result).toEqual({
      candidates: 0,
      suspended: 0,
      skipped: 0,
      errors: [],
      skippedStripeDisabled: true,
    });
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
    expect(mockSuspendTenant).not.toHaveBeenCalled();
  });

  it('成功時: suspendTenant 呼出 + autoSuspendScheduledAt クリア', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([{ id: TENANT_A }] as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);
    mockSuspendTenant.mockResolvedValue({ tenantId: TENANT_A, suspendedAt: new Date() });

    const result = await autoSuspendDelinquentTenants();

    expect(result.candidates).toBe(1);
    expect(result.suspended).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);

    expect(mockSuspendTenant).toHaveBeenCalledWith(TENANT_A, 'payment_delinquent', 'system-user-uuid');
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_A },
      data: { autoSuspendScheduledAt: null },
    });
  });

  it('ALREADY_SUSPENDED → skip カウンタ (= 既に suspend 済の場合は再キューイングしない)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([{ id: TENANT_A }] as never);
    mockSuspendTenant.mockRejectedValue(new Error('ALREADY_SUSPENDED'));

    const result = await autoSuspendDelinquentTenants();

    expect(result.skipped).toBe(1);
    expect(result.suspended).toBe(0);
    expect(result.errors).toEqual([]);
    // skip 時は update も呼ばない
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('TENANT_DELETED → skip', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([{ id: TENANT_A }] as never);
    mockSuspendTenant.mockRejectedValue(new Error('TENANT_DELETED'));

    const result = await autoSuspendDelinquentTenants();
    expect(result.skipped).toBe(1);
  });

  it('MANAGEMENT_TENANT_FORBIDDEN → skip (= 防御的、findMany フィルタで除外されるはずだが念のため)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([{ id: TENANT_A }] as never);
    mockSuspendTenant.mockRejectedValue(new Error('MANAGEMENT_TENANT_FORBIDDEN'));

    const result = await autoSuspendDelinquentTenants();
    expect(result.skipped).toBe(1);
  });

  it('予期せぬエラー → errors に追加 (= 全体は止まらない)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: TENANT_A },
      { id: TENANT_B },
    ] as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);
    mockSuspendTenant
      .mockRejectedValueOnce(new Error('DB connection lost'))
      .mockResolvedValueOnce({});

    const result = await autoSuspendDelinquentTenants();

    expect(result.candidates).toBe(2);
    expect(result.suspended).toBe(1); // B は成功
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([{ tenantId: TENANT_A, error: 'DB connection lost' }]);
  });

  it('複数候補の混在ケース (成功 + skip + error)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: 'tenant-1' },
      { id: 'tenant-2' },
      { id: 'tenant-3' },
    ] as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);
    mockSuspendTenant
      .mockResolvedValueOnce({}) // tenant-1 成功
      .mockRejectedValueOnce(new Error('ALREADY_SUSPENDED')) // tenant-2 skip
      .mockRejectedValueOnce(new Error('Unexpected DB error')); // tenant-3 error

    const result = await autoSuspendDelinquentTenants();

    expect(result.candidates).toBe(3);
    expect(result.suspended).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.tenantId).toBe('tenant-3');
  });
});
