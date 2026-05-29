/**
 * テナントストレージ使用量集計サービスの単体テスト。
 *
 * chore/storage-addon-backend-removal (2026-05-26):
 *   ADR-0020/0021 で従量課金化されたため、旧 4 段階プラン (Standard/Plus/Pro/Enterprise) 関連の
 *   テスト (getStorageInfo / isStorageWriteBlocked / updateStorageAddonPlan /
 *   cancelScheduledStorageAddon / checkAndStartGracePeriod / applyScheduledStorageChanges /
 *   Stripe sync) はすべて削除。calculateTenantStorageBytes + updateAllStorageBytesUsed の
 *   pure 関数挙動のみテストする。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
}));

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));

vi.mock('@/services/tenant-storage-tables.service', () => ({
  calculateTenantStorageBytesDynamic: vi.fn(async () => BigInt(0)),
  getDbInstanceSizeBytes: vi.fn(async () => BigInt(0)),
}));

// ADR-0025 (2026-05-29): File Storage 再集計サービスをモック
vi.mock('@/services/file-storage-bucket-usage.service', () => ({
  syncTenantFileStorageUsage: vi.fn(async () => ({ usedBytes: BigInt(0) })),
}));

import {
  calculateTenantStorageBytes,
  updateAllStorageBytesUsed,
  updateStorageBytesUsedForTenant,
  recalculateTenantStorageUsageWithDebounce,
  maybeRecalcAfterBeginnerDelete,
  BEGINNER_RECALC_DEBOUNCE_MS,
} from './tenant-storage.service';
import { prisma } from '@/lib/db';
import { syncTenantFileStorageUsage } from '@/services/file-storage-bucket-usage.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('calculateTenantStorageBytes', () => {
  it('$queryRaw の戻り値 total_bytes を BigInt で返す', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ total_bytes: BigInt(771872) }] as never);
    const bytes = await calculateTenantStorageBytes('tenant-A');
    expect(typeof bytes).toBe('bigint');
    expect(bytes).toBe(BigInt(771872));
  });

  it('$queryRaw の戻り値が空でも BigInt(0) を返す (fallback)', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([] as never);
    const bytes = await calculateTenantStorageBytes('tenant-A');
    expect(bytes).toBe(BigInt(0));
  });
});

describe('updateStorageBytesUsedForTenant', () => {
  it('テナント不在 → null', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null as never);
    const result = await updateStorageBytesUsedForTenant('missing');
    expect(result).toBeNull();
  });

  it('テナント存在 → calculate + update で BigInt 返却', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({ id: 'tenant-A' } as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ total_bytes: BigInt(12345) }] as never);
    vi.mocked(prisma.tenant.update).mockResolvedValueOnce({} as never);
    const result = await updateStorageBytesUsedForTenant('tenant-A');
    expect(result).toBe(BigInt(12345));
    expect(prisma.tenant.update).toHaveBeenCalled();
  });
});

describe('updateAllStorageBytesUsed', () => {
  it('対象テナント 0 件 → 0 を返す', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([] as never);
    const count = await updateAllStorageBytesUsed();
    expect(count).toBe(0);
  });
});

// ================================================================
// ADR-0025 (2026-05-29): debounce 付き自動再集計 + Beginner DELETE wrapper
// ================================================================

describe('recalculateTenantStorageUsageWithDebounce (ADR-0025)', () => {
  const TENANT_ID = 'tenant-A';

  it('storageBytesUsedAt が null → recalc 実行', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageBytesUsedAt: null,
    } as never);
    // updateStorageBytesUsedForTenant 内の find + update mock
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({ id: TENANT_ID } as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { total_bytes: BigInt(1000) },
    ] as never);

    const r = await recalculateTenantStorageUsageWithDebounce(TENANT_ID);
    expect(r.status).toBe('recalculated');
    expect(syncTenantFileStorageUsage).toHaveBeenCalledWith(TENANT_ID);
  });

  it('storageBytesUsedAt が 30s 以内 → skip', async () => {
    const recent = new Date(Date.now() - 5000); // 5秒前
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageBytesUsedAt: recent,
    } as never);

    const r = await recalculateTenantStorageUsageWithDebounce(TENANT_ID);
    expect(r.status).toBe('skipped-debounce');
    expect(syncTenantFileStorageUsage).not.toHaveBeenCalled();
  });

  it('storageBytesUsedAt が 31s 経過 → recalc 実行', async () => {
    const stale = new Date(Date.now() - 31 * 1000);
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageBytesUsedAt: stale,
    } as never);
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({ id: TENANT_ID } as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { total_bytes: BigInt(2000) },
    ] as never);

    const r = await recalculateTenantStorageUsageWithDebounce(TENANT_ID);
    expect(r.status).toBe('recalculated');
  });

  it('テナント不在 → failed status (throw しない、fail-safe)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null as never);
    const r = await recalculateTenantStorageUsageWithDebounce(TENANT_ID);
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('tenant-not-found');
  });

  it('recalc 例外時 → failed status (throw しない、fail-safe)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockRejectedValueOnce(new Error('db error'));
    const r = await recalculateTenantStorageUsageWithDebounce(TENANT_ID);
    expect(r.status).toBe('failed');
  });

  it('BEGINNER_RECALC_DEBOUNCE_MS = 30000 (= 30秒)', () => {
    expect(BEGINNER_RECALC_DEBOUNCE_MS).toBe(30 * 1000);
  });
});

describe('maybeRecalcAfterBeginnerDelete (ADR-0025)', () => {
  const TENANT_ID = 'tenant-A';

  it('Beginner プラン → recalc 呼出 (syncTenantFileStorageUsage が呼ばれる)', async () => {
    // plan 取得
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({ plan: 'beginner' } as never);
    // debounce check (storageBytesUsedAt null = recalc 実行)
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageBytesUsedAt: null,
    } as never);
    // updateStorageBytesUsedForTenant 内 mock
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({ id: TENANT_ID } as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { total_bytes: BigInt(0) },
    ] as never);

    await maybeRecalcAfterBeginnerDelete(TENANT_ID);
    expect(syncTenantFileStorageUsage).toHaveBeenCalled();
  });

  it('Expert プラン → recalc 呼出されない (plan 早期 return)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({ plan: 'expert' } as never);

    await maybeRecalcAfterBeginnerDelete(TENANT_ID);
    expect(syncTenantFileStorageUsage).not.toHaveBeenCalled();
  });

  it('Pro プラン → recalc 呼出されない', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({ plan: 'pro' } as never);

    await maybeRecalcAfterBeginnerDelete(TENANT_ID);
    expect(syncTenantFileStorageUsage).not.toHaveBeenCalled();
  });

  it('テナント不在 → fail-safe で sailent (throw しない)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null as never);
    await expect(maybeRecalcAfterBeginnerDelete(TENANT_ID)).resolves.toBeUndefined();
  });

  it('plan fetch 例外 → fail-safe で silent (throw しない)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockRejectedValueOnce(new Error('db error'));
    await expect(maybeRecalcAfterBeginnerDelete(TENANT_ID)).resolves.toBeUndefined();
  });

  it('plan fetch 例外時 recordError を warn で呼ぶ (= 可観測性確保、ADR-0025 修正 §3.5)', async () => {
    const { recordError } = await import('@/services/error-log.service');
    vi.mocked(prisma.tenant.findFirst).mockRejectedValueOnce(new Error('db connection lost'));
    await maybeRecalcAfterBeginnerDelete(TENANT_ID);
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warn',
        context: expect.objectContaining({
          kind: 'beginner_recalc_plan_fetch_failed',
          tenantId: TENANT_ID,
          adr: 'ADR-0025',
        }),
      }),
    );
  });
});
