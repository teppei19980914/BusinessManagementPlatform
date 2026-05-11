/**
 * storage-guard.service の単体テスト (PR-3 / 2026-05-15)
 *
 * 検証観点:
 *   - precheckStorageLimit: キャッシュ値ベースで超過/未超過を判定
 *   - assertStorageLimitInTx: transaction 内で実測 → 超過時に StorageLimitExceededError throw
 *   - withStorageGuard: $transaction + Post-check の wrapper として機能
 *   - mapStorageGuardErrorToResponse: 403 STORAGE_LIMIT_EXCEEDED マッピング
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => {
  const txTenant = {
    findFirst: vi.fn(),
    update: vi.fn(),
  };
  const tx = {
    tenant: txTenant,
    project: { create: vi.fn() },
    $queryRaw: vi.fn(),
  };
  return {
    prisma: {
      tenant: {
        findFirst: vi.fn(),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
      __tx: tx,
    },
  };
});

// calculateTenantStorageBytes は本テストでは tx 側で $queryRaw が呼ばれるので不要だが、
// import 順序で評価されないようスタブ。
vi.mock('@/services/tenant-storage.service', () => ({
  calculateTenantStorageBytes: vi.fn(),
}));

import {
  precheckStorageLimit,
  assertStorageLimitInTx,
  withStorageGuard,
  mapStorageGuardErrorToResponse,
  StorageLimitExceededError,
} from './storage-guard.service';
import { prisma } from '@/lib/db';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ONE_MB = 1024 * 1024;

type MockedTx = {
  tenant: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  project: { create: ReturnType<typeof vi.fn> };
  $queryRaw: ReturnType<typeof vi.fn>;
};
const tx = (prisma as unknown as { __tx: MockedTx }).__tx;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('precheckStorageLimit (キャッシュ値ベース)', () => {
  it('使用量 + payload が Standard 20MB 内 → ok=true', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(10 * ONE_MB),
    } as never);

    const r = await precheckStorageLimit(TENANT_ID, 5 * ONE_MB);
    expect(r.ok).toBe(true);
  });

  it('使用量 + payload が Standard 20MB 超過 → ok=false', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(15 * ONE_MB),
    } as never);

    const r = await precheckStorageLimit(TENANT_ID, 10 * ONE_MB);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('STORAGE_LIMIT_EXCEEDED');
      expect(r.addonPlan).toBe('standard');
      expect(r.limitBytes).toBe(20 * ONE_MB);
    }
  });

  it('Plus プラン 220MB: 100MB + 50MB 追加で ok=true', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageAddonPlan: 'plus',
      storageBytesUsed: BigInt(100 * ONE_MB),
    } as never);

    const r = await precheckStorageLimit(TENANT_ID, 50 * ONE_MB);
    expect(r.ok).toBe(true);
  });

  it('不正な storageAddonPlan は standard 扱い (defensive)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageAddonPlan: 'unknown_plan',
      storageBytesUsed: BigInt(0),
    } as never);

    const r = await precheckStorageLimit(TENANT_ID, 5 * ONE_MB);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.limitBytes).toBe(20 * ONE_MB);
  });
});

describe('assertStorageLimitInTx', () => {
  it('実測 ≤ 上限 → throw しない + キャッシュ更新', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(0),
    });
    tx.$queryRaw.mockResolvedValueOnce([{ total_bytes: BigInt(10 * ONE_MB) }]);

    await expect(
      assertStorageLimitInTx(tx as never, TENANT_ID),
    ).resolves.not.toThrow();

    expect(tx.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TENANT_ID },
        data: expect.objectContaining({
          storageBytesUsed: BigInt(10 * ONE_MB),
        }),
      }),
    );
  });

  it('実測 > 上限 → StorageLimitExceededError', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(0),
    });
    tx.$queryRaw.mockResolvedValueOnce([{ total_bytes: BigInt(25 * ONE_MB) }]);

    await expect(
      assertStorageLimitInTx(tx as never, TENANT_ID),
    ).rejects.toBeInstanceOf(StorageLimitExceededError);
  });

  it('実測 = 上限 → throw しない (= 境界値で許容)', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(0),
    });
    tx.$queryRaw.mockResolvedValueOnce([{ total_bytes: BigInt(20 * ONE_MB) }]);

    await expect(
      assertStorageLimitInTx(tx as never, TENANT_ID),
    ).resolves.not.toThrow();
  });
});

describe('withStorageGuard', () => {
  it('fn 実行 → Post-check 成功で transaction commit', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(0),
    });
    tx.$queryRaw.mockResolvedValueOnce([{ total_bytes: BigInt(5 * ONE_MB) }]);
    tx.project.create.mockResolvedValueOnce({ id: 'p1' });

    const result = await withStorageGuard(TENANT_ID, (txc) =>
      (txc as MockedTx).project.create({ data: { name: 'test' } } as never),
    );

    expect(result).toEqual({ id: 'p1' });
    expect(tx.project.create).toHaveBeenCalled();
  });

  it('Post-check 失敗 → StorageLimitExceededError が外に伝播', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(0),
    });
    tx.$queryRaw.mockResolvedValueOnce([{ total_bytes: BigInt(100 * ONE_MB) }]);
    tx.project.create.mockResolvedValueOnce({ id: 'p1' });

    await expect(
      withStorageGuard(TENANT_ID, (txc) =>
        (txc as MockedTx).project.create({ data: { name: 'test' } } as never),
      ),
    ).rejects.toBeInstanceOf(StorageLimitExceededError);
  });
});

describe('mapStorageGuardErrorToResponse', () => {
  it('StorageLimitExceededError → 403 + code STORAGE_LIMIT_EXCEEDED', () => {
    const err = new StorageLimitExceededError({
      tenantId: TENANT_ID,
      currentBytes: 25 * ONE_MB,
      limitBytes: 20 * ONE_MB,
      addonPlan: 'standard',
    });

    const res = mapStorageGuardErrorToResponse(err);
    expect(res).not.toBeNull();
    if (res) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('STORAGE_LIMIT_EXCEEDED');
      expect(res.body.error.currentBytes).toBe(25 * ONE_MB);
      expect(res.body.error.limitBytes).toBe(20 * ONE_MB);
    }
  });

  it('他の Error は null を返す (= caller が throw を再 raise)', () => {
    expect(mapStorageGuardErrorToResponse(new Error('other'))).toBeNull();
    expect(mapStorageGuardErrorToResponse(null)).toBeNull();
    expect(mapStorageGuardErrorToResponse('string error')).toBeNull();
  });
});
