import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      updateMany: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));

import {
  applyScheduledPlanChanges,
  getCurrentMonthStartUtc,
  resetTenantMonthlyCounters,
  runTenantMonthlyReset,
} from './tenant-monthly-reset.service';
import { prisma } from '@/lib/db';
import { recordError } from '@/services/error-log.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCurrentMonthStartUtc', () => {
  it('月途中の日付から当月 1 日 00:00 UTC を返す', () => {
    const result = getCurrentMonthStartUtc(new Date('2026-05-15T08:30:00Z'));
    expect(result.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('月初当日でも当月 1 日 00:00 UTC を返す (冪等)', () => {
    const result = getCurrentMonthStartUtc(new Date('2026-05-01T00:00:00Z'));
    expect(result.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('月末でも当月 1 日 00:00 UTC を返す', () => {
    const result = getCurrentMonthStartUtc(new Date('2026-05-31T23:59:59Z'));
    expect(result.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('UTC 境界の前後で月が変わる場合も UTC 基準で判定', () => {
    // JST 2026-06-01T00:00:00+09:00 = UTC 2026-05-31T15:00:00Z
    const result = getCurrentMonthStartUtc(new Date('2026-05-31T15:00:00Z'));
    expect(result.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('resetTenantMonthlyCounters', () => {
  it('updateMany で deletedAt=null かつ lastResetAt < monthStart を絞り込み', async () => {
    vi.mocked(prisma.tenant.updateMany).mockResolvedValue({ count: 3 } as never);

    const count = await resetTenantMonthlyCounters(
      new Date('2026-05-15T08:00:00Z'),
    );

    expect(count).toBe(3);
    expect(prisma.tenant.updateMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        OR: [
          { lastResetAt: null },
          { lastResetAt: { lt: new Date('2026-05-01T00:00:00Z') } },
        ],
      },
      data: {
        currentMonthApiCallCount: 0,
        currentMonthApiCostJpy: 0,
        lastResetAt: new Date('2026-05-01T00:00:00Z'),
      },
    });
  });

  it('対象 0 件でも例外なく 0 を返す (冪等動作)', async () => {
    vi.mocked(prisma.tenant.updateMany).mockResolvedValue({ count: 0 } as never);
    const count = await resetTenantMonthlyCounters();
    expect(count).toBe(0);
  });
});

describe('applyScheduledPlanChanges', () => {
  it('scheduledPlanChangeAt <= now の候補を取得して plan を適用', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: 'tenant-a', scheduledNextPlan: 'beginner' },
      { id: 'tenant-b', scheduledNextPlan: 'expert' },
    ] as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const now = new Date('2026-05-01T00:00:00Z');
    const result = await applyScheduledPlanChanges(now);

    expect(result.applied).toBe(2);
    expect(result.invalidSkipped).toBe(0);

    expect(prisma.tenant.findMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        scheduledPlanChangeAt: { lte: now },
        scheduledNextPlan: { not: null },
      },
      select: { id: true, scheduledNextPlan: true },
    });

    // 1 件目: beginner にダウングレード
    expect(prisma.tenant.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'tenant-a' },
      data: {
        plan: 'beginner',
        scheduledPlanChangeAt: null,
        scheduledNextPlan: null,
      },
    });
    // 2 件目: expert に変更
    expect(prisma.tenant.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'tenant-b' },
      data: {
        plan: 'expert',
        scheduledPlanChangeAt: null,
        scheduledNextPlan: null,
      },
    });
  });

  it('scheduledNextPlan が不正値なら skip + recordError、他テナントは継続', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: 'tenant-a', scheduledNextPlan: 'beginner' },
      { id: 'tenant-b', scheduledNextPlan: 'invalid_plan' },
      { id: 'tenant-c', scheduledNextPlan: 'pro' },
    ] as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const result = await applyScheduledPlanChanges();

    expect(result.applied).toBe(2); // a, c
    expect(result.invalidSkipped).toBe(1); // b
    expect(prisma.tenant.update).toHaveBeenCalledTimes(2);
    expect(recordError).toHaveBeenCalledTimes(1);

    const errCall = vi.mocked(recordError).mock.calls[0]![0];
    expect(errCall.severity).toBe('error');
    expect(errCall.source).toBe('cron');
    expect(errCall.message).toContain('invalid_plan');
    expect(errCall.context).toMatchObject({
      kind: 'tenant_plan_apply',
      tenantId: 'tenant-b',
    });
  });

  it('scheduledNextPlan が null なら skip (型ガードで弾く)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: 'tenant-a', scheduledNextPlan: null },
    ] as never);

    const result = await applyScheduledPlanChanges();

    expect(result.applied).toBe(0);
    expect(result.invalidSkipped).toBe(1);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('1 テナント update 失敗は他テナントの適用を止めない', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: 'tenant-a', scheduledNextPlan: 'expert' },
      { id: 'tenant-b', scheduledNextPlan: 'pro' },
      { id: 'tenant-c', scheduledNextPlan: 'beginner' },
    ] as never);
    vi.mocked(prisma.tenant.update)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error('DB connection lost'))
      .mockResolvedValueOnce({} as never);

    const result = await applyScheduledPlanChanges();

    expect(result.applied).toBe(2); // a と c は成功、b は失敗
    expect(prisma.tenant.update).toHaveBeenCalledTimes(3);
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        source: 'cron',
        message: 'DB connection lost',
        context: expect.objectContaining({ tenantId: 'tenant-b' }),
      }),
    );
  });

  it('対象 0 件なら applied=0, invalidSkipped=0', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([] as never);
    const result = await applyScheduledPlanChanges();
    expect(result).toEqual({ applied: 0, invalidSkipped: 0 });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });
});

describe('runTenantMonthlyReset (バッチ全体)', () => {
  it('reset → apply の順で実行し、結果を集計して返す', async () => {
    vi.mocked(prisma.tenant.updateMany).mockResolvedValue({ count: 5 } as never);
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: 'tenant-a', scheduledNextPlan: 'beginner' },
      { id: 'tenant-b', scheduledNextPlan: 'invalid' },
    ] as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const result = await runTenantMonthlyReset(new Date('2026-05-01T00:00:00Z'));

    expect(result).toEqual({
      resetCount: 5,
      planAppliedCount: 1,
      invalidPlanSkippedCount: 1,
    });
  });
});
