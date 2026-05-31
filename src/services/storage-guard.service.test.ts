/**
 * storage-guard.service の単体テスト (2026-05-31 改修 / ADR-0030 累積ハードキャップ撤去)
 *
 * 検証観点:
 *   - precheckStorageLimit: Beginner 無料枠のみ判定 (累積 50GB ハードキャップは撤去)
 *   - assertStorageLimitInTx: peak / level 更新 + Beginner ガード + 計測失敗 fail-open
 *   - precheckFileStorageLimit / assertFileStorageLimitInTx: 同上 (ファイル)
 *   - mapBeginnerWriteGuardErrorToResponse: Beginner 超過 UX 文言
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SI_GB_BYTES } from '@/config/db-capacity-pricing';

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

// 動的計測サービスをモック
vi.mock('@/services/tenant-storage-tables.service', () => ({
  calculateTenantStorageBytesDynamic: vi.fn(),
}));

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));

import {
  precheckStorageLimit,
  assertStorageLimitInTx,
  withStorageGuard,
  precheckFileStorageLimit,
  assertFileStorageLimitInTx,
  BeginnerWriteGuardExceededError,
  mapBeginnerWriteGuardErrorToResponse,
} from './storage-guard.service';
import { prisma } from '@/lib/db';
import { calculateTenantStorageBytesDynamic } from '@/services/tenant-storage-tables.service';
import { recordError } from '@/services/error-log.service';
import { SI_MB_BYTES } from '@/config/file-storage-pricing';
import { BEGINNER_DB_FREE_TIER_BYTES } from '@/config/db-capacity-pricing';
import { BEGINNER_STORAGE_FREE_TIER_BYTES } from '@/config/file-storage-pricing';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

type MockedTx = {
  tenant: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  project: { create: ReturnType<typeof vi.fn> & ((args?: unknown) => Promise<unknown>) };
  $queryRaw: ReturnType<typeof vi.fn>;
};
const tx = (prisma as unknown as { __tx: MockedTx }).__tx;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('precheckStorageLimit (累積 50GB ハードキャップ撤去 / Beginner 無料枠のみ)', () => {
  it('非 Beginner: 使用量 10GB + 1GB → ok=true', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      plan: 'expert',
      storageBytesUsed: BigInt(10 * SI_GB_BYTES),
    } as never);

    const r = await precheckStorageLimit(TENANT_ID, 1 * SI_GB_BYTES);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.limitBytes).toBe(BEGINNER_DB_FREE_TIER_BYTES);
  });

  it('非 Beginner: 使用量 60GB (旧 50GB ハードキャップ超) でも ok=true (累積上限撤去)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      plan: 'pro',
      storageBytesUsed: BigInt(60 * SI_GB_BYTES),
    } as never);

    const r = await precheckStorageLimit(TENANT_ID, 2 * SI_GB_BYTES);
    expect(r.ok).toBe(true);
  });

  it('テナント不在は defensive に通す (404 は別経路で処理)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null as never);
    const r = await precheckStorageLimit(TENANT_ID, 0);
    expect(r.ok).toBe(true);
  });
});

describe('assertStorageLimitInTx — peak/level 更新 (累積ハードキャップ撤去)', () => {
  it('実測 5GB → throw しない + peak / cache 更新', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'expert',
      storageBytesPeakThisMonth: BigInt(0),
      dbCapacityWarningLevel: 'none',
    });
    vi.mocked(calculateTenantStorageBytesDynamic).mockResolvedValueOnce(BigInt(5 * SI_GB_BYTES));

    await expect(assertStorageLimitInTx(tx as never, TENANT_ID)).resolves.not.toThrow();

    expect(tx.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TENANT_ID },
        data: expect.objectContaining({
          storageBytesUsed: BigInt(5 * SI_GB_BYTES),
          storageBytesPeakThisMonth: BigInt(5 * SI_GB_BYTES),
        }),
      }),
    );
  });

  it('実測 60GB (旧 50GB ハードキャップ超) → throw しない (累積上限撤去) + peak 更新', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'expert',
      storageBytesPeakThisMonth: BigInt(0),
      dbCapacityWarningLevel: 'l2',
    });
    vi.mocked(calculateTenantStorageBytesDynamic).mockResolvedValueOnce(
      BigInt(60 * SI_GB_BYTES),
    );

    await expect(assertStorageLimitInTx(tx as never, TENANT_ID)).resolves.not.toThrow();
    expect(tx.tenant.update).toHaveBeenCalled();
  });

  it('peak は MAX で更新 (= 削除→write でも巻戻らない)', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'expert',
      storageBytesPeakThisMonth: BigInt(30 * SI_GB_BYTES),
      dbCapacityWarningLevel: 'l2',
    });
    vi.mocked(calculateTenantStorageBytesDynamic).mockResolvedValueOnce(
      BigInt(25 * SI_GB_BYTES),
    );

    await assertStorageLimitInTx(tx as never, TENANT_ID);

    const updateCall = tx.tenant.update.mock.calls[0]?.[0] as {
      data: { storageBytesPeakThisMonth?: bigint };
    };
    expect(updateCall.data.storageBytesPeakThisMonth).toBeUndefined();
  });

  it('warning Level 昇格時のみ super_admin に通知 (= spam 防止)', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'expert',
      storageBytesPeakThisMonth: BigInt(0),
      dbCapacityWarningLevel: 'none',
    });
    vi.mocked(calculateTenantStorageBytesDynamic).mockResolvedValueOnce(
      BigInt(10 * SI_GB_BYTES),
    );

    await assertStorageLimitInTx(tx as never, TENANT_ID);

    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ kind: 'db_capacity_warning', newLevel: 'l2' }),
      }),
    );
  });

  it('Level 横ばい時は通知しない (= spam 防止)', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'expert',
      storageBytesPeakThisMonth: BigInt(0),
      dbCapacityWarningLevel: 'l1',
    });
    vi.mocked(calculateTenantStorageBytesDynamic).mockResolvedValueOnce(
      BigInt(3 * SI_GB_BYTES),
    );

    await assertStorageLimitInTx(tx as never, TENANT_ID);

    const dbCapacityWarningCalls = vi
      .mocked(recordError)
      .mock.calls.filter(
        (c) => (c[0] as { context?: { kind?: string } })?.context?.kind === 'db_capacity_warning',
      );
    expect(dbCapacityWarningCalls.length).toBe(0);
  });
});

describe('assertStorageLimitInTx — 計測失敗 fail-open (ADR-0030)', () => {
  it('計測失敗 → throw せず recordError のみ + peak 更新 skip (write は通る)', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'expert',
      storageBytesPeakThisMonth: BigInt(0),
      dbCapacityWarningLevel: 'none',
    });
    vi.mocked(calculateTenantStorageBytesDynamic).mockRejectedValueOnce(
      new Error('connection timeout'),
    );

    await expect(assertStorageLimitInTx(tx as never, TENANT_ID)).resolves.not.toThrow();

    // peak 更新は skip (= tenant.update 呼ばれない)
    expect(tx.tenant.update).not.toHaveBeenCalled();
    // 計測失敗を記録 (= 日次 cron が補正する旨)
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warn',
        context: expect.objectContaining({ kind: 'storage_guard_measure_failed' }),
      }),
    );
  });
});

describe('withStorageGuard', () => {
  it('fn 実行 → Post-check 成功で transaction commit', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'expert',
      storageBytesPeakThisMonth: BigInt(0),
      dbCapacityWarningLevel: 'none',
    });
    vi.mocked(calculateTenantStorageBytesDynamic).mockResolvedValueOnce(BigInt(5 * SI_GB_BYTES));
    tx.project.create.mockResolvedValueOnce({ id: 'p1' });

    const result = await withStorageGuard(TENANT_ID, (txc) =>
      (txc as unknown as MockedTx).project.create({ data: { name: 'test' } } as never),
    );

    expect(result).toEqual({ id: 'p1' });
    expect(tx.project.create).toHaveBeenCalled();
  });

  it('Beginner 無料枠超過 → BeginnerWriteGuardExceededError が外に伝播', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'beginner',
      storageBytesPeakThisMonth: BigInt(0),
      dbCapacityWarningLevel: 'none',
    });
    vi.mocked(calculateTenantStorageBytesDynamic).mockResolvedValueOnce(
      BigInt(BEGINNER_DB_FREE_TIER_BYTES + 1),
    );
    tx.project.create.mockResolvedValueOnce({ id: 'p1' });

    await expect(
      withStorageGuard(TENANT_ID, (txc) =>
        (txc as unknown as MockedTx).project.create({ data: { name: 'test' } } as never),
      ),
    ).rejects.toBeInstanceOf(BeginnerWriteGuardExceededError);
  });
});

// ================================================================
// ファイルストレージ guard (ADR-0021 / 累積ハードキャップ撤去)
// ================================================================

describe('precheckFileStorageLimit (累積 50GB ハードキャップ撤去 / Beginner 無料枠のみ)', () => {
  it('非 Beginner: 使用量 10GB + 1GB → ok=true', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      plan: 'expert',
      storageFileBytesUsed: BigInt(10 * SI_GB_BYTES),
    } as never);

    const r = await precheckFileStorageLimit(TENANT_ID, 1 * SI_GB_BYTES);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.limitBytes).toBe(BEGINNER_STORAGE_FREE_TIER_BYTES);
  });

  it('非 Beginner: 使用量 60GB (旧 50GB ハードキャップ超) でも ok=true (累積上限撤去)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      plan: 'pro',
      storageFileBytesUsed: BigInt(60 * SI_GB_BYTES),
    } as never);

    const r = await precheckFileStorageLimit(TENANT_ID, 2 * SI_GB_BYTES);
    expect(r.ok).toBe(true);
  });

  it('テナント不在は defensive に通す', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null as never);
    const r = await precheckFileStorageLimit(TENANT_ID, 0);
    expect(r.ok).toBe(true);
  });
});

describe('assertFileStorageLimitInTx — peak/level 更新 (累積ハードキャップ撤去)', () => {
  it('追加 50MB → throw しない + cache / peak 更新', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'expert',
      storageFileBytesUsed: BigInt(0),
      storageFileBytesPeakThisMonth: BigInt(0),
      fileStorageWarningLevel: 'none',
    });

    await expect(
      assertFileStorageLimitInTx(tx as never, TENANT_ID, 50 * SI_MB_BYTES),
    ).resolves.not.toThrow();

    expect(tx.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TENANT_ID },
        data: expect.objectContaining({
          storageFileBytesUsed: BigInt(50 * SI_MB_BYTES),
          storageFileBytesPeakThisMonth: BigInt(50 * SI_MB_BYTES),
        }),
      }),
    );
  });

  it('加算後 60GB (旧 50GB ハードキャップ超) → throw しない (累積上限撤去)', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'expert',
      storageFileBytesUsed: BigInt(58 * SI_GB_BYTES),
      storageFileBytesPeakThisMonth: BigInt(58 * SI_GB_BYTES),
      fileStorageWarningLevel: 'l2',
    });

    await expect(
      assertFileStorageLimitInTx(tx as never, TENANT_ID, 2 * SI_GB_BYTES),
    ).resolves.not.toThrow();
  });

  it('peak は MAX で更新 (= 削除→write でも巻戻らない)', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'expert',
      storageFileBytesUsed: BigInt(30 * SI_GB_BYTES),
      storageFileBytesPeakThisMonth: BigInt(30 * SI_GB_BYTES),
      fileStorageWarningLevel: 'l2',
    });

    await assertFileStorageLimitInTx(tx as never, TENANT_ID, -5 * SI_GB_BYTES);

    const updateCall = tx.tenant.update.mock.calls[0]?.[0] as {
      data: { storageFileBytesUsed: bigint; storageFileBytesPeakThisMonth?: bigint };
    };
    expect(updateCall.data.storageFileBytesUsed).toBe(BigInt(25 * SI_GB_BYTES));
    expect(updateCall.data.storageFileBytesPeakThisMonth).toBeUndefined();
  });

  it('削除で使用量が負になる場合は 0 で clamp', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'expert',
      storageFileBytesUsed: BigInt(100),
      storageFileBytesPeakThisMonth: BigInt(100),
      fileStorageWarningLevel: 'none',
    });

    await assertFileStorageLimitInTx(tx as never, TENANT_ID, -200);

    const updateCall = tx.tenant.update.mock.calls[0]?.[0] as {
      data: { storageFileBytesUsed: bigint };
    };
    expect(updateCall.data.storageFileBytesUsed).toBe(BigInt(0));
  });

  it('warning Level 昇格時のみ通知 (none → l2)', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'expert',
      storageFileBytesUsed: BigInt(0),
      storageFileBytesPeakThisMonth: BigInt(0),
      fileStorageWarningLevel: 'none',
    });

    await assertFileStorageLimitInTx(tx as never, TENANT_ID, 10 * SI_GB_BYTES);

    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ kind: 'file_storage_warning', newLevel: 'l2' }),
      }),
    );
  });

  it('Level 横ばい時は通知しない (= spam 防止)', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'expert',
      storageFileBytesUsed: BigInt(3 * SI_GB_BYTES),
      storageFileBytesPeakThisMonth: BigInt(3 * SI_GB_BYTES),
      fileStorageWarningLevel: 'l1',
    });

    await assertFileStorageLimitInTx(tx as never, TENANT_ID, 1 * SI_GB_BYTES);

    const fileStorageWarnCalls = vi
      .mocked(recordError)
      .mock.calls.filter(
        (c) => (c[0] as { context?: { kind?: string } })?.context?.kind === 'file_storage_warning',
      );
    expect(fileStorageWarnCalls.length).toBe(0);
  });
});

// ================================================================
// ADR-0025 (2026-05-29): Beginner プラン write ガード (維持)
// ================================================================

describe('ADR-0025: Beginner プラン DB write ガード — precheckStorageLimit', () => {
  it('Beginner プラン × 50MB 直前 → ok=true (許可)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      plan: 'beginner',
      storageBytesUsed: BigInt(BEGINNER_DB_FREE_TIER_BYTES - 1000),
    } as never);

    const r = await precheckStorageLimit(TENANT_ID, 500);
    expect(r.ok).toBe(true);
  });

  it('Beginner プラン × 50MB 超過 → ok=false (BEGINNER_DB_QUOTA_EXCEEDED)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      plan: 'beginner',
      storageBytesUsed: BigInt(BEGINNER_DB_FREE_TIER_BYTES + 1000),
    } as never);

    const r = await precheckStorageLimit(TENANT_ID, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('BEGINNER_DB_QUOTA_EXCEEDED');
      expect(r.limitBytes).toBe(BEGINNER_DB_FREE_TIER_BYTES);
    }
  });

  it('Expert プラン × 50MB 超過 → ok=true (Beginner ガード対象外、累積上限なし)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      plan: 'expert',
      storageBytesUsed: BigInt(BEGINNER_DB_FREE_TIER_BYTES + 1000),
    } as never);

    const r = await precheckStorageLimit(TENANT_ID, 0);
    expect(r.ok).toBe(true);
  });

  it('Pro プラン × 50MB 超過 → ok=true (Beginner ガード対象外)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      plan: 'pro',
      storageBytesUsed: BigInt(BEGINNER_DB_FREE_TIER_BYTES + 1000),
    } as never);

    const r = await precheckStorageLimit(TENANT_ID, 0);
    expect(r.ok).toBe(true);
  });
});

describe('ADR-0025: Beginner プラン DB write ガード — assertStorageLimitInTx', () => {
  it('Beginner × 実測 > 50MB → BeginnerWriteGuardExceededError', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'beginner',
      storageBytesPeakThisMonth: BigInt(0),
      dbCapacityWarningLevel: 'none',
    });
    vi.mocked(calculateTenantStorageBytesDynamic).mockResolvedValueOnce(
      BigInt(BEGINNER_DB_FREE_TIER_BYTES + 1),
    );

    await expect(assertStorageLimitInTx(tx as never, TENANT_ID)).rejects.toBeInstanceOf(
      BeginnerWriteGuardExceededError,
    );
  });

  it('Beginner × 実測 = 50MB ちょうど → throw しない (境界値で許容)', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'beginner',
      storageBytesPeakThisMonth: BigInt(0),
      dbCapacityWarningLevel: 'none',
    });
    vi.mocked(calculateTenantStorageBytesDynamic).mockResolvedValueOnce(
      BigInt(BEGINNER_DB_FREE_TIER_BYTES),
    );

    await expect(assertStorageLimitInTx(tx as never, TENANT_ID)).resolves.not.toThrow();
  });

  it('Expert × 実測 5GB → throw しない (Beginner ガード対象外)', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'expert',
      storageBytesPeakThisMonth: BigInt(0),
      dbCapacityWarningLevel: 'none',
    });
    vi.mocked(calculateTenantStorageBytesDynamic).mockResolvedValueOnce(
      BigInt(5 * SI_GB_BYTES),
    );

    await expect(assertStorageLimitInTx(tx as never, TENANT_ID)).resolves.not.toThrow();
  });
});

describe('ADR-0025: Beginner プラン File Storage write ガード — precheckFileStorageLimit', () => {
  it('Beginner × 100MB 直前 → ok=true (許可)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      plan: 'beginner',
      storageFileBytesUsed: BigInt(BEGINNER_STORAGE_FREE_TIER_BYTES - 1000),
    } as never);

    const r = await precheckFileStorageLimit(TENANT_ID, 500);
    expect(r.ok).toBe(true);
  });

  it('Beginner × 100MB 超 (新ファイル size 含む) → ok=false (BEGINNER_STORAGE_QUOTA_EXCEEDED)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      plan: 'beginner',
      storageFileBytesUsed: BigInt(BEGINNER_STORAGE_FREE_TIER_BYTES - 1000),
    } as never);

    const r = await precheckFileStorageLimit(TENANT_ID, 5000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('BEGINNER_STORAGE_QUOTA_EXCEEDED');
      expect(r.limitBytes).toBe(BEGINNER_STORAGE_FREE_TIER_BYTES);
    }
  });

  it('Expert × 100MB 超 → ok=true (Beginner ガード対象外)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      plan: 'expert',
      storageFileBytesUsed: BigInt(BEGINNER_STORAGE_FREE_TIER_BYTES + 1000),
    } as never);

    const r = await precheckFileStorageLimit(TENANT_ID, 0);
    expect(r.ok).toBe(true);
  });
});

describe('ADR-0025: Beginner プラン File Storage write ガード — assertFileStorageLimitInTx', () => {
  it('Beginner × アップロード後 > 100MB → BeginnerWriteGuardExceededError', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'beginner',
      storageFileBytesUsed: BigInt(BEGINNER_STORAGE_FREE_TIER_BYTES - 1000),
      storageFileBytesPeakThisMonth: BigInt(0),
      fileStorageWarningLevel: 'none',
    });

    await expect(
      assertFileStorageLimitInTx(tx as never, TENANT_ID, 5000),
    ).rejects.toBeInstanceOf(BeginnerWriteGuardExceededError);
  });

  it('Beginner × ファイル削除 (addedBytes < 0) → 100MB 超でも許可 (DELETE は対象外)', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      plan: 'beginner',
      storageFileBytesUsed: BigInt(BEGINNER_STORAGE_FREE_TIER_BYTES + 10000),
      storageFileBytesPeakThisMonth: BigInt(BEGINNER_STORAGE_FREE_TIER_BYTES + 10000),
      fileStorageWarningLevel: 'none',
    });

    await expect(
      assertFileStorageLimitInTx(tx as never, TENANT_ID, -5000),
    ).resolves.not.toThrow();
  });
});

describe('ADR-0025: mapBeginnerWriteGuardErrorToResponse', () => {
  it('BEGINNER_DB_QUOTA_EXCEEDED → 403 + UX 文言 + upgradeUrl', () => {
    const err = new BeginnerWriteGuardExceededError({
      tenantId: TENANT_ID,
      quotaType: 'db',
      currentBytes: 60_000_000,
      limitBytes: BEGINNER_DB_FREE_TIER_BYTES,
    });
    const res = mapBeginnerWriteGuardErrorToResponse(err);
    expect(res).not.toBeNull();
    if (res) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('BEGINNER_DB_QUOTA_EXCEEDED');
      expect(res.body.error.quotaType).toBe('db');
      expect(res.body.error.message).toContain('Beginner プラン');
      expect(res.body.error.message).toContain('Expert');
      expect(res.body.error.upgradeUrl).toBe('/settings/tenant');
      expect(res.body.error.currentBytes).toBe(60_000_000);
      expect(res.body.error.limitBytes).toBe(BEGINNER_DB_FREE_TIER_BYTES);
    }
  });

  it('BEGINNER_STORAGE_QUOTA_EXCEEDED → 403 + quotaType=storage', () => {
    const err = new BeginnerWriteGuardExceededError({
      tenantId: TENANT_ID,
      quotaType: 'storage',
      currentBytes: 110_000_000,
      limitBytes: BEGINNER_STORAGE_FREE_TIER_BYTES,
    });
    const res = mapBeginnerWriteGuardErrorToResponse(err);
    expect(res).not.toBeNull();
    if (res) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('BEGINNER_STORAGE_QUOTA_EXCEEDED');
      expect(res.body.error.quotaType).toBe('storage');
    }
  });

  it('他の Error は null を返す', () => {
    expect(mapBeginnerWriteGuardErrorToResponse(new Error('other'))).toBeNull();
    expect(mapBeginnerWriteGuardErrorToResponse(null)).toBeNull();
  });
});
