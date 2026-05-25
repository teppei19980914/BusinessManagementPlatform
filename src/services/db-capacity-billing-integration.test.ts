/**
 * DB 容量従量課金フローの統合テスト (ADR-0020 / 2026-05-25)
 *
 * シナリオ A-D の end-to-end 検証 (mock prisma + service 統合):
 *   - A. 通常利用: 月初 cron → ApiCallLog INSERT → Stripe queue enqueue → reset
 *   - B. 抜け道試行 (月末削除→月初再投入): peak 維持で正しく課金
 *   - C. ハードキャップ到達: write 拒否
 *   - D. billing invariant: ApiCallLog.costJpy = Stripe Meter quantity 完全一致
 *
 * 関連:
 *   - ADR-0020 §9 テスト戦略
 *   - 単体: db-capacity-pricing.test.ts (計算) / tenant-monthly-reset.service.test.ts (cron) /
 *     storage-guard.service.test.ts (post-check)
 *   - 本ファイル: 単体テスト間の経路接続を mock prisma 上で確認
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => {
  const tx = {
    tenant: { update: vi.fn(() => Promise.resolve({})) },
    apiCallLog: { create: vi.fn() },
    stripeUsageRecordQueue: { create: vi.fn() },
    auditLog: { create: vi.fn() },
    user: { findFirst: vi.fn(() => Promise.resolve(null)) },
  };
  return {
    prisma: {
      tenant: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      user: { findFirst: vi.fn(() => Promise.resolve(null)), groupBy: vi.fn(() => Promise.resolve([])) },
      auditLog: { create: vi.fn() },
      tenantMonthlyUsageHistory: { upsert: vi.fn() },
      apiCallLog: {
        aggregate: vi.fn(() =>
          Promise.resolve({ _count: { _all: 0 }, _sum: { costJpy: null } }),
        ),
      },
      $transaction: vi.fn(),
      __tx: tx,
    },
  };
});

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));
vi.mock('@/services/embedding-backfill.service', () => ({
  runMonthlyEmbeddingBackfill: vi.fn(async () => ({ tenantCount: 0, results: [] })),
}));
vi.mock('@/services/super-admin.service', () => ({
  purgeOldDeletedTenants: vi.fn(async () => ({ succeeded: 0, totalRowsDeleted: 0 })),
}));
vi.mock('@/services/tenant-storage.service', () => ({
  applyScheduledStorageChanges: vi.fn(async () => ({ applied: 0, skippedDueToUsage: 0 })),
}));

import { prisma } from '@/lib/db';
import { billOneTenantDbCapacityOverage } from './tenant-monthly-reset.service';
import { calculateOverageJpy, SI_MB_BYTES, SI_GB_BYTES } from '@/config/db-capacity-pricing';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
type MockedTx = {
  tenant: { update: ReturnType<typeof vi.fn> };
  apiCallLog: { create: ReturnType<typeof vi.fn> };
  stripeUsageRecordQueue: { create: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
  user: { findFirst: ReturnType<typeof vi.fn> };
};
const txMock = (prisma as unknown as { __tx: MockedTx }).__tx;

beforeEach(() => {
  vi.clearAllMocks();
  txMock.apiCallLog.create.mockImplementation(
    (args: { data: { id?: string } }) => Promise.resolve({ id: args.data.id ?? 'mock-log' }),
  );
  txMock.stripeUsageRecordQueue.create.mockResolvedValue({ id: 'mock-queue' });
  txMock.auditLog.create.mockResolvedValue({});
  txMock.tenant.update.mockResolvedValue({});

  vi.mocked(prisma.$transaction).mockImplementation((async (fn: unknown) => {
    if (typeof fn === 'function') return await fn(txMock);
    return fn;
  }) as never);
});

describe('シナリオ A: 通常利用 (徐々に使用量増加 → 月初請求)', () => {
  it('peak 200MB → ¥50 課金 + 全 3 経路 (ApiCallLog / counter / Stripe queue) で同額', async () => {
    const result = await billOneTenantDbCapacityOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageBytesUsed: BigInt(200 * SI_MB_BYTES),
      storageBytesPeakThisMonth: BigInt(200 * SI_MB_BYTES),
      billingScope: 'previous-month',
      now: new Date('2026-06-01T00:00:00Z'),
    });

    expect(result.billedJpy).toBe(50);
    // ApiCallLog.create 呼出 で costJpy=50
    const logCall = txMock.apiCallLog.create.mock.calls[0]?.[0] as {
      data: { costJpy: number; featureUnit: string };
    };
    expect(logCall.data.costJpy).toBe(50);
    expect(logCall.data.featureUnit).toBe('db-capacity-overage');
    // Stripe Queue.create で quantity=50 (= R6 案 A 整合)
    const queueCall = txMock.stripeUsageRecordQueue.create.mock.calls[0]?.[0] as {
      data: { quantity: number; callType: string };
    };
    expect(queueCall.data.quantity).toBe(50);
    expect(queueCall.data.callType).toBe('db_capacity_overage');
  });
});

describe('シナリオ B: 抜け道試行 (月末削除→月初再投入)', () => {
  it('current=100MB だが peak=10GB → peak ベースで ¥500 課金 (抜け道防止)', async () => {
    const result = await billOneTenantDbCapacityOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageBytesUsed: BigInt(100 * SI_MB_BYTES), // 月末削除後
      storageBytesPeakThisMonth: BigInt(10 * SI_GB_BYTES), // 月中 peak 10GB
      billingScope: 'previous-month',
      now: new Date('2026-06-01T00:00:00Z'),
    });

    // 10GB - 50MB ≒ 9,950MB billable → ceil(9950/1000) = 10 tier → ¥500
    expect(result.billedJpy).toBe(500);
  });

  it('current=0 (= 完全削除済) でも peak=1GB → ¥50 課金', async () => {
    const result = await billOneTenantDbCapacityOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageBytesUsed: BigInt(0),
      storageBytesPeakThisMonth: BigInt(SI_GB_BYTES),
      billingScope: 'previous-month',
      now: new Date('2026-06-01T00:00:00Z'),
    });
    expect(result.billedJpy).toBe(50);
  });
});

describe('シナリオ C: 50GB ハードキャップ到達', () => {
  it('peak=50GB ちょうど → ¥2,500 課金 (= tier 50 max)', async () => {
    const result = await billOneTenantDbCapacityOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageBytesUsed: BigInt(50 * SI_GB_BYTES),
      storageBytesPeakThisMonth: BigInt(50 * SI_GB_BYTES),
      billingScope: 'previous-month',
      now: new Date('2026-06-01T00:00:00Z'),
    });
    expect(result.billedJpy).toBe(2500);
  });

  it('peak=ハードキャップ + 退会時即時請求でも整合', async () => {
    const result = await billOneTenantDbCapacityOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageBytesUsed: BigInt(50 * SI_GB_BYTES),
      storageBytesPeakThisMonth: BigInt(50 * SI_GB_BYTES),
      billingScope: 'current-month-on-withdrawal',
      now: new Date('2026-05-25T10:00:00Z'),
    });
    expect(result.billedJpy).toBe(2500);

    // requestId に 'current-month-on-withdrawal' 含まれる (B-1 修正済)
    const logCall = txMock.apiCallLog.create.mock.calls[0]?.[0] as {
      data: { requestId: string };
    };
    expect(logCall.data.requestId).toContain('current-month-on-withdrawal');
  });
});

describe('シナリオ D: billing invariant (ApiCallLog.costJpy = Stripe quantity)', () => {
  it.each([
    { peakMb: 50, expectedJpy: 0 },
    { peakMb: 51, expectedJpy: 50 },
    { peakMb: 1050, expectedJpy: 50 },
    { peakMb: 1051, expectedJpy: 100 },
    { peakMb: 5000, expectedJpy: 250 },
    { peakMb: 10050, expectedJpy: 500 },
  ])(
    'peak=%peakMbMB → JS 計算 ¥%expectedJpy = ApiCallLog.costJpy = Stripe quantity',
    async ({ peakMb, expectedJpy }) => {
      const peakBytes = BigInt(peakMb * SI_MB_BYTES);

      // 純粋計算ヘルパ (= db-capacity-pricing.ts)
      const calc = calculateOverageJpy(peakBytes);
      expect(calc).toBe(expectedJpy);

      // service 経路 (= billOneTenantDbCapacityOverage)
      const result = await billOneTenantDbCapacityOverage({
        tenantId: TENANT_ID,
        timezone: 'Asia/Tokyo',
        storageBytesUsed: peakBytes,
        storageBytesPeakThisMonth: peakBytes,
        billingScope: 'previous-month',
        now: new Date('2026-06-01T00:00:00Z'),
      });
      expect(result.billedJpy).toBe(expectedJpy);

      // 課金時のみ ApiCallLog + Stripe queue が同額で INSERT される
      if (expectedJpy > 0) {
        const logCall = txMock.apiCallLog.create.mock.calls.at(-1)?.[0] as {
          data: { costJpy: number };
        };
        const queueCall = txMock.stripeUsageRecordQueue.create.mock.calls.at(-1)?.[0] as {
          data: { quantity: number };
        };
        expect(logCall.data.costJpy).toBe(expectedJpy);
        expect(queueCall.data.quantity).toBe(expectedJpy);
        // billing invariant: ApiCallLog SUM = Stripe Meter quantity (R6 案 A)
        expect(logCall.data.costJpy).toBe(queueCall.data.quantity);
      } else {
        // ¥0 ならどちらも INSERT されない
        expect(txMock.apiCallLog.create).not.toHaveBeenCalled();
        expect(txMock.stripeUsageRecordQueue.create).not.toHaveBeenCalled();
      }
    },
  );
});
