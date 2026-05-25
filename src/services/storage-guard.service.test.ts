/**
 * storage-guard.service の単体テスト (ADR-0020 / 2026-05-25 改修)
 *
 * 検証観点:
 *   - precheckStorageLimit: キャッシュ値ベースで 50GB ハードキャップ判定
 *   - assertStorageLimitInTx: SELECT FOR UPDATE + 動的計測 + peak / level / circuit breaker 更新
 *   - circuit breaker: 計測 3 回連続失敗で open + super_admin alert
 *   - withStorageGuard: $transaction + Post-check の wrapper
 *   - mapStorageGuardErrorToResponse: STORAGE_LIMIT_EXCEEDED / CIRCUIT_OPEN マッピング
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DB_CAPACITY_L3_HARD_CAP_BYTES, SI_GB_BYTES } from '@/config/db-capacity-pricing';

vi.mock('@/lib/db', () => {
  const txTenant = {
    findFirst: vi.fn(),
    update: vi.fn(),
  };
  const tx = {
    tenant: txTenant,
    project: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
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
  mapStorageGuardErrorToResponse,
  StorageLimitExceededError,
  StorageGuardCircuitOpenError,
} from './storage-guard.service';
import { prisma } from '@/lib/db';
import { calculateTenantStorageBytesDynamic } from '@/services/tenant-storage-tables.service';
import { recordError } from '@/services/error-log.service';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

// vi.fn() の戻り値は (args)=>any & MockProps の組み合わせ。テスト内で create を直接呼びたい場合は
//   ((tx) => tx.project.create(...) as Promise<...>) ではなく awaitable 互換型として扱う。
type MockedTx = {
  tenant: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  project: { create: ReturnType<typeof vi.fn> & ((args?: unknown) => Promise<unknown>) };
  $queryRaw: ReturnType<typeof vi.fn>;
  $queryRawUnsafe: ReturnType<typeof vi.fn>;
};
const tx = (prisma as unknown as { __tx: MockedTx }).__tx;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('precheckStorageLimit (ADR-0020 50GB ハードキャップ)', () => {
  it('使用量 + payload が 50GB 内 → ok=true', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageBytesUsed: BigInt(10 * SI_GB_BYTES),
      storageGuardCircuitOpenedAt: null,
    } as never);

    const r = await precheckStorageLimit(TENANT_ID, 1 * SI_GB_BYTES);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.limitBytes).toBe(DB_CAPACITY_L3_HARD_CAP_BYTES);
  });

  it('使用量 + payload が 50GB 超過 → ok=false', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageBytesUsed: BigInt(49 * SI_GB_BYTES),
      storageGuardCircuitOpenedAt: null,
    } as never);

    const r = await precheckStorageLimit(TENANT_ID, 2 * SI_GB_BYTES);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('STORAGE_LIMIT_EXCEEDED');
      expect(r.limitBytes).toBe(DB_CAPACITY_L3_HARD_CAP_BYTES);
    }
  });

  it('circuit breaker open 中 → ok=false (= fail-close)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      storageBytesUsed: BigInt(0),
      storageGuardCircuitOpenedAt: new Date(),
    } as never);

    const r = await precheckStorageLimit(TENANT_ID, 0);
    expect(r.ok).toBe(false);
  });

  it('テナント不在は defensive に通す (404 は別経路で処理)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null as never);
    const r = await precheckStorageLimit(TENANT_ID, 0);
    expect(r.ok).toBe(true);
  });
});

describe('assertStorageLimitInTx — 通常系', () => {
  it('実測 < ハードキャップ → throw しない + peak / cache 更新', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      storageBytesPeakThisMonth: BigInt(0),
      storageGuardCircuitFailCount: 0,
      storageGuardCircuitOpenedAt: null,
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

  it('実測 > 50GB ハードキャップ → StorageLimitExceededError', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      storageBytesPeakThisMonth: BigInt(0),
      storageGuardCircuitFailCount: 0,
      storageGuardCircuitOpenedAt: null,
      dbCapacityWarningLevel: 'none',
    });
    vi.mocked(calculateTenantStorageBytesDynamic).mockResolvedValueOnce(
      BigInt(51 * SI_GB_BYTES),
    );

    await expect(assertStorageLimitInTx(tx as never, TENANT_ID)).rejects.toBeInstanceOf(
      StorageLimitExceededError,
    );
  });

  it('実測 = 50GB ちょうど → throw しない (境界値で許容)', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      storageBytesPeakThisMonth: BigInt(0),
      storageGuardCircuitFailCount: 0,
      storageGuardCircuitOpenedAt: null,
      dbCapacityWarningLevel: 'none',
    });
    vi.mocked(calculateTenantStorageBytesDynamic).mockResolvedValueOnce(
      BigInt(DB_CAPACITY_L3_HARD_CAP_BYTES),
    );

    await expect(assertStorageLimitInTx(tx as never, TENANT_ID)).resolves.not.toThrow();
  });

  it('peak は MAX で更新 (= 削除→write でも巻戻らない)', async () => {
    // 既存 peak が 30GB、現在使用量 25GB (= 削除後) → peak は 30GB のまま
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      storageBytesPeakThisMonth: BigInt(30 * SI_GB_BYTES),
      storageGuardCircuitFailCount: 0,
      storageGuardCircuitOpenedAt: null,
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
    // 既存 'none' → 新規 'l2' (10GB 到達)
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      storageBytesPeakThisMonth: BigInt(0),
      storageGuardCircuitFailCount: 0,
      storageGuardCircuitOpenedAt: null,
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
      storageBytesPeakThisMonth: BigInt(0),
      storageGuardCircuitFailCount: 0,
      storageGuardCircuitOpenedAt: null,
      dbCapacityWarningLevel: 'l1',
    });
    vi.mocked(calculateTenantStorageBytesDynamic).mockResolvedValueOnce(
      BigInt(3 * SI_GB_BYTES), // l1 範囲内 (1-10GB)
    );

    await assertStorageLimitInTx(tx as never, TENANT_ID);

    // Level 変化なし → recordError 呼ばれない
    const dbCapacityWarningCalls = vi
      .mocked(recordError)
      .mock.calls.filter(
        (c) => (c[0] as { context?: { kind?: string } })?.context?.kind === 'db_capacity_warning',
      );
    expect(dbCapacityWarningCalls.length).toBe(0);
  });
});

describe('assertStorageLimitInTx — circuit breaker (R3 fail-close)', () => {
  it('既に circuit open → StorageGuardCircuitOpenError', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      storageBytesPeakThisMonth: BigInt(0),
      storageGuardCircuitFailCount: 5,
      storageGuardCircuitOpenedAt: new Date(),
      dbCapacityWarningLevel: 'none',
    });

    await expect(assertStorageLimitInTx(tx as never, TENANT_ID)).rejects.toBeInstanceOf(
      StorageGuardCircuitOpenError,
    );
  });

  it('計測失敗 1 回 → fail count increment, circuit は open しない, fail-close で throw', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      storageBytesPeakThisMonth: BigInt(0),
      storageGuardCircuitFailCount: 0,
      storageGuardCircuitOpenedAt: null,
      dbCapacityWarningLevel: 'none',
    });
    vi.mocked(calculateTenantStorageBytesDynamic).mockRejectedValueOnce(
      new Error('connection timeout'),
    );

    await expect(assertStorageLimitInTx(tx as never, TENANT_ID)).rejects.toBeInstanceOf(
      StorageLimitExceededError,
    );

    expect(tx.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storageGuardCircuitFailCount: 1,
          storageGuardCircuitOpenedAt: null,
        }),
      }),
    );
  });

  it('計測失敗 3 回目 → circuit open + super_admin alert', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      storageBytesPeakThisMonth: BigInt(0),
      storageGuardCircuitFailCount: 2, // 既に 2 回失敗、今回 3 回目
      storageGuardCircuitOpenedAt: null,
      dbCapacityWarningLevel: 'none',
    });
    vi.mocked(calculateTenantStorageBytesDynamic).mockRejectedValueOnce(
      new Error('connection timeout'),
    );

    await expect(assertStorageLimitInTx(tx as never, TENANT_ID)).rejects.toBeInstanceOf(
      StorageLimitExceededError,
    );

    // circuit open 状態に
    const updateCall = tx.tenant.update.mock.calls[0]?.[0] as {
      data: { storageGuardCircuitFailCount: number; storageGuardCircuitOpenedAt: Date | null };
    };
    expect(updateCall.data.storageGuardCircuitFailCount).toBe(3);
    expect(updateCall.data.storageGuardCircuitOpenedAt).toBeInstanceOf(Date);

    // super_admin に通知 (severity=error)
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        context: expect.objectContaining({ kind: 'storage_guard_circuit', circuitOpened: true }),
      }),
    );
  });

  it('計測成功時に circuit fail count をリセット', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      storageBytesPeakThisMonth: BigInt(0),
      storageGuardCircuitFailCount: 2,
      storageGuardCircuitOpenedAt: null,
      dbCapacityWarningLevel: 'none',
    });
    vi.mocked(calculateTenantStorageBytesDynamic).mockResolvedValueOnce(BigInt(5 * SI_GB_BYTES));

    await assertStorageLimitInTx(tx as never, TENANT_ID);

    expect(tx.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storageGuardCircuitFailCount: 0,
        }),
      }),
    );
  });
});

describe('withStorageGuard', () => {
  it('fn 実行 → Post-check 成功で transaction commit', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      storageBytesPeakThisMonth: BigInt(0),
      storageGuardCircuitFailCount: 0,
      storageGuardCircuitOpenedAt: null,
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

  it('Post-check 失敗 → StorageLimitExceededError が外に伝播', async () => {
    tx.tenant.findFirst.mockResolvedValueOnce({
      id: TENANT_ID,
      storageBytesPeakThisMonth: BigInt(0),
      storageGuardCircuitFailCount: 0,
      storageGuardCircuitOpenedAt: null,
      dbCapacityWarningLevel: 'none',
    });
    vi.mocked(calculateTenantStorageBytesDynamic).mockResolvedValueOnce(
      BigInt(51 * SI_GB_BYTES),
    );
    tx.project.create.mockResolvedValueOnce({ id: 'p1' });

    await expect(
      withStorageGuard(TENANT_ID, (txc) =>
        (txc as unknown as MockedTx).project.create({ data: { name: 'test' } } as never),
      ),
    ).rejects.toBeInstanceOf(StorageLimitExceededError);
  });
});

describe('mapStorageGuardErrorToResponse', () => {
  it('StorageLimitExceededError → 403 + code STORAGE_LIMIT_EXCEEDED + 50GB メッセージ', () => {
    const err = new StorageLimitExceededError({
      tenantId: TENANT_ID,
      currentBytes: 51 * SI_GB_BYTES,
      limitBytes: DB_CAPACITY_L3_HARD_CAP_BYTES,
    });

    const res = mapStorageGuardErrorToResponse(err);
    expect(res).not.toBeNull();
    if (res) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('STORAGE_LIMIT_EXCEEDED');
      expect(res.body.error.message).toContain('50GB');
      expect(res.body.error.message).toContain('読み取り・エクスポートは引き続き可能');
    }
  });

  it('StorageGuardCircuitOpenError → 403 + code STORAGE_GUARD_CIRCUIT_OPEN', () => {
    const err = new StorageGuardCircuitOpenError({ tenantId: TENANT_ID, failCount: 3 });
    const res = mapStorageGuardErrorToResponse(err);
    expect(res).not.toBeNull();
    if (res) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('STORAGE_GUARD_CIRCUIT_OPEN');
      expect(res.body.error.message).toContain('一時的');
    }
  });

  it('他の Error は null を返す (= caller が throw を再 raise)', () => {
    expect(mapStorageGuardErrorToResponse(new Error('other'))).toBeNull();
    expect(mapStorageGuardErrorToResponse(null)).toBeNull();
    expect(mapStorageGuardErrorToResponse('string error')).toBeNull();
  });
});
