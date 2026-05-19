/**
 * api-usage-recalc.service の単体テスト (2026-05-14, PR-V8 2026-05-19 改修)
 *
 * 検証項目:
 *   - getCurrentMonthStartUtc: UTC 月初を正しく返す (deprecated だが後方互換)
 *   - reconcileTenantApiUsage:
 *     - テナント存在 + ズレなし → drift=0, hasDrift=false
 *     - テナント存在 + cost ズレ > 5% → hasDrift=true
 *     - テナント存在 + call ズレ > 5% (Beginner cost=0) → hasDrift=true ★PR-V8 で追加 / 本件 regression
 *     - テナント不在 → null
 *     - ApiCallLog 0 行 (新テナント) → reconciled=0, drift=cached
 *     - 月境界はテナント TZ ベース (Asia/Tokyo) ★PR-V8 で追加
 *   - reconcileAllTenantsApiUsage: 個別失敗は除外、成功分のみ返す
 *   - repairTenantApiUsage:
 *     - Tenant counter を SUM で上書き
 *     - actorUserId 指定時は audit_log を transaction で記録 ★PR-V8 で追加
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
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
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
const ACTOR_USER = '00000000-0000-0000-0000-00000000aaaa';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCurrentMonthStartUtc (deprecated)', () => {
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
      timezone: 'Asia/Tokyo',
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
    expect(result?.driftCallRatio).toBe(0);
    expect(result?.driftCostRatio).toBe(0);
    expect(result?.driftRatio).toBe(0);
    expect(result?.hasDrift).toBe(false);
  });

  it('cost ズレ 20% (cached > reconciled) → hasDrift=true, driftCostRatio>callRatio', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_A,
      timezone: 'Asia/Tokyo',
      currentMonthApiCallCount: 100,
      currentMonthApiCostJpy: 1200,
    } as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _count: { _all: 100 },
      _sum: { costJpy: 1000 },
    } as never);

    const result = await reconcileTenantApiUsage(TENANT_A);
    expect(result?.driftCallCount).toBe(0);
    expect(result?.driftCostJpy).toBe(200);
    expect(result?.driftCallRatio).toBe(0);
    expect(result?.driftCostRatio).toBeCloseTo(0.2, 2);
    expect(result?.driftRatio).toBeCloseTo(0.2, 2); // max(0, 0.2)
    expect(result?.hasDrift).toBe(true);
  });

  // ★ PR-V8 / 本件 (Default テナント drift 7/8 沈黙) の regression test
  it('Beginner プラン (cost=0) で call ズレ 7/8 → hasDrift=true ★本件 regression', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_A,
      timezone: 'Asia/Tokyo',
      currentMonthApiCallCount: 1, // 本件 Default の counter (壊れた値)
      currentMonthApiCostJpy: 0, // Beginner は cost=0
    } as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _count: { _all: 8 }, // 本件 Default の ApiCallLog SUM (真値)
      _sum: { costJpy: 0 }, // Beginner cost=0
    } as never);

    const result = await reconcileTenantApiUsage(TENANT_A);
    // 旧設計だと driftCostRatio = 0/max(0,1) = 0 で hasDrift=false になっていた
    expect(result?.driftCallCount).toBe(-7); // counter 不足
    expect(result?.driftCostJpy).toBe(0);
    expect(result?.driftCallRatio).toBeCloseTo(7 / 8, 3); // 0.875
    expect(result?.driftCostRatio).toBe(0); // cost=0 なので 0
    expect(result?.driftRatio).toBeCloseTo(0.875, 3); // max(0.875, 0)
    expect(result?.hasDrift).toBe(true); // ★ 旧設計だと false で沈黙していた
  });

  it('ズレ 4.9% (閾値未満) → hasDrift=false', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_A,
      timezone: 'Asia/Tokyo',
      currentMonthApiCallCount: 100,
      currentMonthApiCostJpy: 1049,
    } as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _count: { _all: 100 },
      _sum: { costJpy: 1000 },
    } as never);

    const result = await reconcileTenantApiUsage(TENANT_A);
    expect(result?.driftCostRatio).toBeCloseTo(0.049, 3);
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
      timezone: 'Asia/Tokyo',
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

  // ★ PR-V8: 月境界はテナント TZ 月初 (Asia/Tokyo 5/1 00:00 = UTC 4/30 15:00)
  it('Asia/Tokyo テナント → monthStart は UTC 4/30T15:00 (= JST 5/1T00:00)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_A,
      timezone: 'Asia/Tokyo',
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
          createdAt: { gte: new Date('2026-04-30T15:00:00.000Z') }, // JST 5/1 00:00
        }),
      }),
    );
  });

  // ★ テナント分離: aggregate where 句に tenantId が確実に入っていること
  it('[テナント分離] aggregate query の where には tenantId が必須 (他テナントの ApiCallLog を吸わない)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_A,
      timezone: 'Asia/Tokyo',
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
        timezone: 'Asia/Tokyo',
        currentMonthApiCallCount: 10,
        currentMonthApiCostJpy: 100,
      } as never)
      .mockResolvedValueOnce({
        id: TENANT_B,
        timezone: 'Asia/Tokyo',
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
        timezone: 'Asia/Tokyo',
        currentMonthApiCallCount: 10,
        currentMonthApiCostJpy: 100,
      } as never)
      .mockResolvedValueOnce({
        id: TENANT_B,
        timezone: 'Asia/Tokyo',
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
  it('drift があるテナントの counter を ApiCallLog SUM で上書き (actorUserId なし → audit なし)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_A,
      timezone: 'Asia/Tokyo',
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
    // actorUserId なし → $transaction (audit セット) は呼ばれない
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // ★ PR-V8: actorUserId 指定時は audit_log を transaction で記録
  it('actorUserId 指定 → $transaction で counter update + audit_log create を実行', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_A,
      timezone: 'Asia/Tokyo',
      currentMonthApiCallCount: 1, // 本件 Default の壊れた値
      currentMonthApiCostJpy: 0,
    } as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _count: { _all: 8 }, // 真値
      _sum: { costJpy: 0 },
    } as never);
    vi.mocked(prisma.$transaction).mockResolvedValue([] as never);

    const result = await repairTenantApiUsage(TENANT_A, ACTOR_USER);

    expect(result?.cachedCallCount).toBe(8);
    expect(result?.driftCallCount).toBe(0);
    expect(result?.hasDrift).toBe(false);
    // $transaction が呼ばれる (audit ありパス)
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // mock 環境では tenant.update も呼ばれるが (= $transaction に渡す PrismaPromise の生成)、
    //   実 DB では $transaction 内部で atomic に実行される。
    //   両者が同時に呼ばれることが「audit 付き repair」パスの証拠。
    expect(prisma.tenant.update).toHaveBeenCalledTimes(1);
  });

  it('テナント不在 → null + update を呼ばない', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(null as never);
    const result = await repairTenantApiUsage('non-existent');
    expect(result).toBeNull();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
