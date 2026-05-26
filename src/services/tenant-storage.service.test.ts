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

import {
  calculateTenantStorageBytes,
  updateAllStorageBytesUsed,
  updateStorageBytesUsedForTenant,
} from './tenant-storage.service';
import { prisma } from '@/lib/db';

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
