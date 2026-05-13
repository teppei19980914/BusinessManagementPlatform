/**
 * api-usage-recalc.service の単体テスト (2026-05-14)
 *
 * 検証項目:
 *   - getCurrentMonthStartUtc: UTC 月初を正しく返す (タイムゾーン依存しない)
 *   - reconcileTenantApiUsage:
 *     - テナント存在 + ズレなし → drift=0, hasDrift=false
 *     - テナント存在 + ズレ > 5% → hasDrift=true
 *     - テナント不在 → null
 *     - ApiCallLog 0 行 (新テナント) → reconciled=0, drift=cached
 *   - reconcileAllTenantsApiUsage: 個別失敗は除外、成功分のみ返す
 *   - repairTenantApiUsage: Tenant counter を SUM で上書き
 *   - テナント分離: tenantId フィルタが ApiCallLog aggregate where に確実に伝播する
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    apiCallLog: {
      aggregate: vi.fn(),
    },
  },
}));

import {
  getCurrentMonthStartUtc,
  reconcileTenantApiUsage,
  reconcileAllTenantsApiUsage,
  repairTenantApiUsage,
  DRIFT_WARNING_THRESHOLD,
} from './api-usage-recalc.service';
import { prisma } from '@/lib/db';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCurrentMonthStartUtc', () => {
  it('月中の日時 → 当月 UTC 月初 0:00 を返す', () => {
    const now = new Date('2026-05-14T15:30:45Z');
    expect(getCurrentMonthStartUtc(now).toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('月初 0:00 はそのまま当月 1 日 を返す', () => {
    const now = new Date('2026-05-01T00:00:00Z');
    expect(getCurrentMonthStartUtc(now).toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('12 月末 → 12 月 1 日を返す (年跨ぎなし)', () => {
    const now = new Date('2026-12-31T23:59:59Z');
    expect(getCurrentMonthStartUtc(now).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('reconcileTenantApiUsage', () => {
  it('ズレなし (cached = reconciled) → driftRatio=0, hasDrift=false', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_A,
      currentMonthApiCallCount: 100,
      currentMonthApiCostJpy: 1000,
    } as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _count: { _all: 100 },
      _sum: { costJpy: 1000 },
    } as never);

    const result = await reconcileTenantApiUsage(TENANT_A, new Date('2026-05-14T00:00:00Z'));
    expect(result).not.toBeNull();
    expect(result?.driftCallCount).toBe(0);
    expect(result?.driftCostJpy).toBe(0);
    expect(result?.driftRatio).toBe(0);
    expect(result?.hasDrift).toBe(false);
  });

  it('ズレ 5% 超 (cached > reconciled) → hasDrift=true, drift 正値 (counter 過剰)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_A,
      currentMonthApiCallCount: 110,
      currentMonthApiCostJpy: 1200,
    } as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _count: { _all: 100 },
      _sum: { costJpy: 1000 },
    } as never);

    const result = await reconcileTenantApiUsage(TENANT_A);
    expect(result?.driftCallCount).toBe(10);
    expect(result?.driftCostJpy).toBe(200);
    expect(result?.driftRatio).toBeCloseTo(0.2, 2);
    expect(result?.hasDrift).toBe(true);
  });

  it('ズレ 4.9% (閾値未満) → hasDrift=false', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_A,
      currentMonthApiCallCount: 100,
      currentMonthApiCostJpy: 1049,
    } as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _count: { _all: 100 },
      _sum: { costJpy: 1000 },
    } as never);

    const result = await reconcileTenantApiUsage(TENANT_A);
    expect(result?.driftRatio).toBeCloseTo(0.049, 3);
    expect(result?.hasDrift).toBe(false);
  });

  it('テナント不在 → null', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(null as never);
    const result = await reconcileTenantApiUsage('non-existent');
    expect(result).toBeNull();
    expect(prisma.apiCallLog.aggregate).not.toHaveBeenCalled();
  });

  it('ApiCallLog 0 行 (新テナント) → reconciled=0, ÷ 0 にならず driftRatio 計算可能', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_A,
      currentMonthApiCallCount: 0,
      currentMonthApiCostJpy: 0,
    } as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _count: { _all: 0 },
      _sum: { costJpy: null },
    } as never);

    const result = await reconcileTenantApiUsage(TENANT_A);
    expect(result?.reconciledCallCount).toBe(0);
    expect(result?.reconciledCostJpy).toBe(0);
    expect(result?.driftRatio).toBe(0);
    expect(result?.hasDrift).toBe(false);
  });

  // ★ テナント分離: aggregate where 句に tenantId が確実に入っていること
  it('[テナント分離] aggregate query の where には tenantId が必須 (他テナントの ApiCallLog を吸わない)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_A,
      currentMonthApiCallCount: 0,
      currentMonthApiCostJpy: 0,
    } as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _count: { _all: 0 },
      _sum: { costJpy: null },
    } as never);

    await reconcileTenantApiUsage(TENANT_A, new Date('2026-05-14T00:00:00Z'));

    expect(prisma.apiCallLog.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT_A,
          createdAt: { gte: new Date('2026-05-01T00:00:00.000Z') },
        }),
      }),
    );
  });

  it('DRIFT_WARNING_THRESHOLD 定数は 0.05 (5%)', () => {
    expect(DRIFT_WARNING_THRESHOLD).toBe(0.05);
  });
});

describe('reconcileAllTenantsApiUsage', () => {
  it('成功 2 件 → 全件返す', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: TENANT_A },
      { id: TENANT_B },
    ] as never);
    vi.mocked(prisma.tenant.findFirst)
      .mockResolvedValueOnce({
        id: TENANT_A,
        currentMonthApiCallCount: 10,
        currentMonthApiCostJpy: 100,
      } as never)
      .mockResolvedValueOnce({
        id: TENANT_B,
        currentMonthApiCallCount: 20,
        currentMonthApiCostJpy: 200,
      } as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _count: { _all: 10 },
      _sum: { costJpy: 100 },
    } as never);

    const results = await reconcileAllTenantsApiUsage();
    expect(results).toHaveLength(2);
  });

  it('1 件失敗 (aggregate が throw) → 成功分のみ返す (Promise.allSettled)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: TENANT_A },
      { id: TENANT_B },
    ] as never);
    vi.mocked(prisma.tenant.findFirst)
      .mockResolvedValueOnce({
        id: TENANT_A,
        currentMonthApiCallCount: 10,
        currentMonthApiCostJpy: 100,
      } as never)
      .mockResolvedValueOnce({
        id: TENANT_B,
        currentMonthApiCallCount: 20,
        currentMonthApiCostJpy: 200,
      } as never);
    vi.mocked(prisma.apiCallLog.aggregate)
      .mockRejectedValueOnce(new Error('DB timeout'))
      .mockResolvedValueOnce({
        _count: { _all: 20 },
        _sum: { costJpy: 200 },
      } as never);

    const results = await reconcileAllTenantsApiUsage();
    expect(results).toHaveLength(1);
    expect(results[0].tenantId).toBe(TENANT_B);
  });

  it('削除済テナント除外 (findMany の where に deletedAt: null)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([] as never);
    await reconcileAllTenantsApiUsage();
    expect(prisma.tenant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null },
      }),
    );
  });
});

describe('repairTenantApiUsage', () => {
  it('drift があるテナントの counter を ApiCallLog SUM で上書き', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_A,
      currentMonthApiCallCount: 110,
      currentMonthApiCostJpy: 1200,
    } as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _count: { _all: 100 },
      _sum: { costJpy: 1000 },
    } as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const result = await repairTenantApiUsage(TENANT_A);
    expect(result?.cachedCallCount).toBe(100);
    expect(result?.cachedCostJpy).toBe(1000);
    expect(result?.driftRatio).toBe(0);
    expect(result?.hasDrift).toBe(false);
    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TENANT_A },
        data: {
          currentMonthApiCallCount: 100,
          currentMonthApiCostJpy: 1000,
        },
      }),
    );
  });

  it('テナント不在 → null + update を呼ばない', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(null as never);
    const result = await repairTenantApiUsage('non-existent');
    expect(result).toBeNull();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });
});
