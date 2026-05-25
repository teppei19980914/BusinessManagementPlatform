/**
 * requireStorageQuotaForWrite ヘルパの単体テスト (ADR-0020 / 2026-05-25 改修)
 *
 * 検証観点:
 *   - 上限 (50GB SI ハードキャップ) 内なら null を返す (= 続行 OK)
 *   - 上限超過なら 403 STORAGE_LIMIT_EXCEEDED の NextResponse を返す
 *   - 超過 response の body にキャッシュ値・上限が含まれる (addonPlan は廃止)
 *   - circuit breaker open 中も拒否される (= fail-close)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DB_CAPACITY_L3_HARD_CAP_BYTES, SI_GB_BYTES } from '@/config/db-capacity-pricing';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/permissions', () => ({
  checkPermission: vi.fn(),
  checkMembership: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findFirst: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db';
import { requireStorageQuotaForWrite } from './api-helpers';

const TENANT_ID = 'tenant-uuid-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireStorageQuotaForWrite (ADR-0020 50GB ハードキャップ)', () => {
  it('50GB 内 (使用 10GB + 追加 1GB) → null', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageBytesUsed: BigInt(10 * SI_GB_BYTES),
      storageGuardCircuitOpenedAt: null,
    } as never);

    const r = await requireStorageQuotaForWrite(TENANT_ID, 1 * SI_GB_BYTES);
    expect(r).toBeNull();
  });

  it('50GB 超過 (使用 49GB + 追加 2GB) → 403 STORAGE_LIMIT_EXCEEDED', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageBytesUsed: BigInt(49 * SI_GB_BYTES),
      storageGuardCircuitOpenedAt: null,
    } as never);

    const r = await requireStorageQuotaForWrite(TENANT_ID, 2 * SI_GB_BYTES);
    expect(r).not.toBeNull();
    if (r) {
      expect(r.status).toBe(403);
      const body = await r.json();
      expect(body.error.code).toBe('STORAGE_LIMIT_EXCEEDED');
      expect(body.error.limitBytes).toBe(DB_CAPACITY_L3_HARD_CAP_BYTES);
      // ADR-0020: addonPlan は廃止
      expect(body.error.addonPlan).toBeUndefined();
    }
  });

  it('estimatedBytes 省略時はキャッシュ値のみで判定 (= 既に超過のテナントを弾く)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageBytesUsed: BigInt(51 * SI_GB_BYTES), // 既に 50GB 超過
      storageGuardCircuitOpenedAt: null,
    } as never);

    const r = await requireStorageQuotaForWrite(TENANT_ID);
    expect(r).not.toBeNull();
    if (r) expect(r.status).toBe(403);
  });

  it('境界値: 使用 + 追加 = 50GB ちょうど → null (= 許可)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageBytesUsed: BigInt(49 * SI_GB_BYTES),
      storageGuardCircuitOpenedAt: null,
    } as never);

    // 49GB + 1GB = 50GB ちょうど → 許可
    const r = await requireStorageQuotaForWrite(TENANT_ID, 1 * SI_GB_BYTES);
    expect(r).toBeNull();
  });

  it('境界値: 使用 + 追加 = 50GB + 1byte → 403', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageBytesUsed: BigInt(49 * SI_GB_BYTES),
      storageGuardCircuitOpenedAt: null,
    } as never);

    // 49GB + 1GB + 1 → 50GB + 1 → 拒否
    const r = await requireStorageQuotaForWrite(TENANT_ID, 1 * SI_GB_BYTES + 1);
    expect(r).not.toBeNull();
  });

  it('circuit breaker open 中 → 403 (R3 fail-close)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageBytesUsed: BigInt(0),
      storageGuardCircuitOpenedAt: new Date(),
    } as never);

    const r = await requireStorageQuotaForWrite(TENANT_ID, 0);
    expect(r).not.toBeNull();
    if (r) expect(r.status).toBe(403);
  });
});
