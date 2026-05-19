/**
 * monthly-history-regenerate.service の単体テスト (PR-V8 / 2026-05-19)
 *
 * ★請求重要 regression★
 *   過去月の請求書根拠 (tenant_monthly_usage_history) が ApiCallLog SUM (真値) で
 *   再生成可能であることを検証する。本件 (Default テナント counter 1 vs SUM 8) のような
 *   drift が起きた月でも、後から正しい数値で履歴を作り直せる invariant。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findFirst: vi.fn(),
    },
    apiCallLog: {
      aggregate: vi.fn(),
    },
    user: {
      count: vi.fn(),
    },
    tenantMonthlyUsageHistory: {
      findUnique: vi.fn(),
      // PR-V8: upsert を $transaction 内で呼ぶため mock 必要 ($transaction が配列引数を
      //   そのまま return するだけだが、配列要素の関数自体が存在しないと vitest が
      //   prisma.tenantMonthlyUsageHistory.upsert is not a function で落ちる)
      upsert: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import { regenerateMonthlyHistoryFromApiCallLog } from './monthly-history-regenerate.service';
import { prisma } from '@/lib/db';

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const ACTOR_USER = '00000000-0000-0000-0000-0000000000aa';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('regenerateMonthlyHistoryFromApiCallLog', () => {
  it('不正な yearMonth (= YYYY-MM 形式違反) → throw', async () => {
    await expect(
      regenerateMonthlyHistoryFromApiCallLog(TENANT_A, '2026-13', ACTOR_USER),
    ).rejects.toThrow(/yearMonth/);
    await expect(
      regenerateMonthlyHistoryFromApiCallLog(TENANT_A, '202605', ACTOR_USER),
    ).rejects.toThrow(/yearMonth/);
  });

  it('テナント不在 → null (DB 更新もしない)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue(null as never);
    const result = await regenerateMonthlyHistoryFromApiCallLog(
      'non-existent',
      '2026-04',
      ACTOR_USER,
    );
    expect(result).toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // ★ PR-V8 請求 regression: 本件 (counter 1 / SUM 8) と同じ drift シナリオで再生成すると
  //   履歴は真値 (8) で上書きされる
  it('★請求 regression★ counter drift 7/8 の月を再生成 → 履歴は SUM 8 で上書き', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_A,
      plan: 'beginner',
      timezone: 'Asia/Tokyo',
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(1000),
    } as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _count: { _all: 8 }, // 真値 (counter は壊れて 1 だったケース)
      _sum: { costJpy: 40 },
    } as never);
    vi.mocked(prisma.user.count).mockResolvedValue(3 as never);
    vi.mocked(prisma.tenantMonthlyUsageHistory.findUnique).mockResolvedValue({
      apiCallCount: 1, // 既存 snapshot (壊れた値)
      apiCostJpy: 5,
    } as never);
    vi.mocked(prisma.$transaction).mockResolvedValue([] as never);

    const result = await regenerateMonthlyHistoryFromApiCallLog(
      TENANT_A,
      '2026-04',
      ACTOR_USER,
    );

    expect(result).not.toBeNull();
    expect(result?.reconciledCallCount).toBe(8); // ★ 真値
    expect(result?.reconciledCostJpy).toBe(40);
    expect(result?.previousSnapshot).toEqual({ apiCallCount: 1, apiCostJpy: 5 });

    // $transaction が呼ばれて、upsert + audit_log が同時に実行される
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    // 範囲が Asia/Tokyo 月初基準 (= 2026-04-01 00:00 JST = 2026-03-31 15:00 UTC)
    expect(result?.rangeStart.toISOString()).toBe('2026-03-31T15:00:00.000Z');
    expect(result?.rangeEnd.toISOString()).toBe('2026-04-30T15:00:00.000Z');
  });

  it('snapshot 不在の月を再生成 → create (previousSnapshot=null)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_A,
      plan: 'expert',
      timezone: 'Asia/Tokyo',
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(0),
    } as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _count: { _all: 100 },
      _sum: { costJpy: 500 },
    } as never);
    vi.mocked(prisma.user.count).mockResolvedValue(2 as never);
    vi.mocked(prisma.tenantMonthlyUsageHistory.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.$transaction).mockResolvedValue([] as never);

    const result = await regenerateMonthlyHistoryFromApiCallLog(
      TENANT_A,
      '2026-05',
      ACTOR_USER,
    );

    expect(result?.previousSnapshot).toBeNull();
    expect(result?.reconciledCallCount).toBe(100);
  });

  it('ApiCallLog 0 件の月 → reconciledCallCount=0 で履歴上書き (空月の保持)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_A,
      plan: 'beginner',
      timezone: 'Asia/Tokyo',
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(0),
    } as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _count: { _all: 0 },
      _sum: { costJpy: null },
    } as never);
    vi.mocked(prisma.user.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.tenantMonthlyUsageHistory.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.$transaction).mockResolvedValue([] as never);

    const result = await regenerateMonthlyHistoryFromApiCallLog(
      TENANT_A,
      '2026-03',
      ACTOR_USER,
    );

    expect(result?.reconciledCallCount).toBe(0);
    expect(result?.reconciledCostJpy).toBe(0);
  });

  it('テナント TZ が UTC → 範囲が UTC 月初〜翌月初に一致', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
      id: TENANT_A,
      plan: 'expert',
      timezone: 'UTC',
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(0),
    } as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _count: { _all: 0 },
      _sum: { costJpy: null },
    } as never);
    vi.mocked(prisma.user.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.tenantMonthlyUsageHistory.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.$transaction).mockResolvedValue([] as never);

    const result = await regenerateMonthlyHistoryFromApiCallLog(
      TENANT_A,
      '2026-04',
      ACTOR_USER,
    );

    expect(result?.rangeStart.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(result?.rangeEnd.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });
});
