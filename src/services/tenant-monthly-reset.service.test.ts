import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      updateMany: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    // P-5b (2026-05-08): snapshot 保存・user 集計用
    tenantMonthlyUsageHistory: {
      upsert: vi.fn(),
    },
    user: {
      groupBy: vi.fn(),
      // PR-V8 (2026-05-19): resetTenantMonthlyCounters が systemUser (super_admin) を
      //   検索するために findFirst を呼ぶ。デフォルトで null (= audit なしパス) を返す。
      findFirst: vi.fn(() => Promise.resolve(null)),
    },
    auditLog: {
      create: vi.fn(),
    },
    // PR-V8.1 (2026-05-19): saveMonthlyUsageSnapshots が ApiCallLog SUM ベースに変更されたため、
    //   apiCallLog.aggregate を mock 必須。デフォルトは「前月分 ApiCallLog 0 件」を返す。
    //   個別 test で counter 値と一致する mock 値を上書き可能。
    apiCallLog: {
      aggregate: vi.fn(() =>
        Promise.resolve({ _count: { _all: 0 }, _sum: { costJpy: null } }),
      ),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));

// 2026-05-14: runMonthlyEmbeddingBackfill が外部 LLM API を呼ぶため、テストでは
//   常に空結果を返すスタブを差し込む。
vi.mock('@/services/embedding-backfill.service', () => ({
  runMonthlyEmbeddingBackfill: vi.fn(async () => ({ tenantCount: 0, results: [] })),
}));

import {
  applyScheduledPlanChanges,
  getCurrentMonthStartUtc,
  getPreviousYearMonth,
  resetTenantMonthlyCounters,
  runTenantMonthlyReset,
  saveMonthlyUsageSnapshots,
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
  it('PR-4: テナント TZ 月初を超えたテナントのみ個別 update する (Asia/Tokyo は 5/1 00:00 JST = 4/30 15:00 UTC 基準)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      // テナントA: Asia/Tokyo、lastResetAt が前月初 (リセット対象)
      {
        id: 'a',
        timezone: 'Asia/Tokyo',
        lastResetAt: new Date('2026-04-01T00:00:00Z'),
      },
      // テナントB: Asia/Tokyo、当月初を既に過ぎている (対象外)
      {
        id: 'b',
        timezone: 'Asia/Tokyo',
        lastResetAt: new Date('2026-05-01T00:00:00Z'),
      },
      // テナントC: UTC、lastResetAt = null (初回リセット対象)
      { id: 'c', timezone: 'UTC', lastResetAt: null },
    ] as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    const count = await resetTenantMonthlyCounters(new Date('2026-05-15T08:00:00Z'));

    // a と c の 2 件が対象
    expect(count).toBe(2);
    expect(prisma.tenant.update).toHaveBeenCalledTimes(2);
  });

  it('対象 0 件でも例外なく 0 を返す (冪等動作)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([] as never);
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
  it('snapshot → reset → apply の順で実行し、結果を集計して返す', async () => {
    // P-5b (2026-05-08): runTenantMonthlyReset は内部で
    // saveMonthlyUsageSnapshots → resetTenantMonthlyCounters → applyScheduledPlanChanges
    // の順で呼ぶ。各ステップは別々のモックで応答する。

    // saveMonthlyUsageSnapshots: 対象 2 件
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      {
        id: 'tenant-a',
        plan: 'beginner',
        timezone: 'Asia/Tokyo',
        lastResetAt: null,
        currentMonthApiCallCount: 50,
        currentMonthApiCostJpy: 0,
      },
      {
        id: 'tenant-b',
        plan: 'expert',
        timezone: 'Asia/Tokyo',
        lastResetAt: null,
        currentMonthApiCallCount: 100,
        currentMonthApiCostJpy: 1000,
      },
    ] as never);
    vi.mocked(prisma.user.groupBy).mockResolvedValueOnce([
      { tenantId: 'tenant-a', _count: { id: 3 } },
      { tenantId: 'tenant-b', _count: { id: 5 } },
    ] as never);
    vi.mocked(prisma.tenantMonthlyUsageHistory.upsert).mockResolvedValue({} as never);

    // resetTenantMonthlyCounters (PR-4: findMany + 個別 update に変更)
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      { id: 'tenant-a', timezone: 'Asia/Tokyo', lastResetAt: null },
      { id: 'tenant-b', timezone: 'Asia/Tokyo', lastResetAt: null },
      { id: 'tenant-c', timezone: 'Asia/Tokyo', lastResetAt: null },
      { id: 'tenant-d', timezone: 'Asia/Tokyo', lastResetAt: null },
      { id: 'tenant-e', timezone: 'Asia/Tokyo', lastResetAt: null },
    ] as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    // applyScheduledPlanChanges
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      { id: 'tenant-c', scheduledNextPlan: 'beginner' },
      { id: 'tenant-d', scheduledNextPlan: 'invalid' },
    ] as never);

    const result = await runTenantMonthlyReset(new Date('2026-05-15T00:00:00Z'));

    expect(result).toEqual({
      resetCount: 5,
      planAppliedCount: 1,
      invalidPlanSkippedCount: 1,
      snapshotSavedCount: 2,
      storageAddonAppliedCount: 0,
      storageAddonSkippedCount: 0,
      purgedTenantCount: 0,
      purgedRowCount: 0,
      // 2026-05-14: 縮退モード確定仕様 — runMonthlyEmbeddingBackfill のスタブが空を返す
      embeddingBackfillTenantCount: 0,
      embeddingBackfillGeneratedCount: 0,
    });
  });
});

describe('getPreviousYearMonth (P-5b / 2026-05-08, PR-4 で TZ 引数追加)', () => {
  it('当月の前月を YYYY-MM で返す (JST default)', () => {
    // JST default: 2026-05-15 17:00 JST → 前月 04
    expect(getPreviousYearMonth(new Date('2026-05-15T08:00:00Z'))).toBe('2026-04');
    // 2026-05-01 09:00 JST → 前月 04
    expect(getPreviousYearMonth(new Date('2026-05-01T00:00:00Z'))).toBe('2026-04');
  });

  it('UTC 月末 23:59:59 は JST だと翌月初なので前月扱いに注意', () => {
    // 2026-05-31T23:59:59Z = JST 2026-06-01 08:59:59 → 6 月扱い → 前月 05
    expect(getPreviousYearMonth(new Date('2026-05-31T23:59:59Z'))).toBe('2026-05');
    // 明示的に UTC 指定なら 04 (= 旧仕様の挙動)
    expect(getPreviousYearMonth(new Date('2026-05-31T23:59:59Z'), 'UTC')).toBe('2026-04');
  });

  it('1 月実行時は前年 12 月を返す', () => {
    expect(getPreviousYearMonth(new Date('2026-01-15T08:00:00Z'))).toBe('2025-12');
    expect(getPreviousYearMonth(new Date('2026-01-01T00:00:00Z'))).toBe('2025-12');
  });

  it('月の桁数は 0 埋め (例: 9 月 → 09)', () => {
    expect(getPreviousYearMonth(new Date('2026-10-15T08:00:00Z'))).toBe('2026-09');
    expect(getPreviousYearMonth(new Date('2026-02-15T08:00:00Z'))).toBe('2026-01');
  });

  it('PR-4: テナント TZ 指定で異なる結果を返す', () => {
    // 2026-05-01T00:00:00Z は UTC で 5月、Asia/Tokyo で同日 09:00 → 5月、America/New_York で 4月末
    expect(getPreviousYearMonth(new Date('2026-05-01T00:00:00Z'), 'UTC')).toBe('2026-04');
    expect(getPreviousYearMonth(new Date('2026-05-01T00:00:00Z'), 'Asia/Tokyo')).toBe('2026-04');
    // 2026-05-01T00:00:00Z = NY 2026-04-30 20:00 → 4月扱い → 前月 03
    expect(getPreviousYearMonth(new Date('2026-05-01T00:00:00Z'), 'America/New_York')).toBe('2026-03');
  });
});

describe('saveMonthlyUsageSnapshots (P-5b / 2026-05-08)', () => {
  it('管理テナント + Default テナント以外を対象に upsert を呼ぶ (2026-05-11 改修)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      {
        id: 'tenant-a',
        plan: 'beginner',
        timezone: 'Asia/Tokyo',
        lastResetAt: null,
        currentMonthApiCallCount: 80,
        currentMonthApiCostJpy: 0,
        storageAddonPlan: 'standard',
        storageBytesUsed: BigInt(0),
      },
      {
        id: 'tenant-b',
        plan: 'pro',
        timezone: 'Asia/Tokyo',
        lastResetAt: null,
        currentMonthApiCallCount: 1200,
        currentMonthApiCostJpy: 36000,
        storageAddonPlan: 'standard',
        storageBytesUsed: BigInt(0),
      },
    ] as never);
    vi.mocked(prisma.user.groupBy).mockResolvedValueOnce([
      { tenantId: 'tenant-a', _count: { id: 2 } },
      { tenantId: 'tenant-b', _count: { id: 8 } },
    ] as never);
    vi.mocked(prisma.tenantMonthlyUsageHistory.upsert).mockResolvedValue({} as never);

    const saved = await saveMonthlyUsageSnapshots(new Date('2026-05-01T00:00:00Z'));

    expect(saved).toBe(2);
    // 2026-05-11 改修: 管理テナント + Default テナント (= 運営者自身、請求対象外) を除外
    // Default が混入すると過去月 CSV エクスポートに不正に含まれてしまうため二重防御
    expect(prisma.tenant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: {
            notIn: [
              '00000000-0000-0000-0000-ffffffffffff', // MANAGEMENT
              '00000000-0000-0000-0000-000000000001', // DEFAULT
            ],
          },
          deletedAt: null,
        }),
      }),
    );
    // upsert は 2 回 (1 テナントあたり 1 回)
    expect(prisma.tenantMonthlyUsageHistory.upsert).toHaveBeenCalledTimes(2);
  });

  it('★PR-V8.1★ 前月 ApiCallLog SUM (真値) を yearMonth=前月 で snapshot 保存する (counter ベースではない)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      {
        id: 'tenant-a',
        plan: 'expert',
        timezone: 'Asia/Tokyo',
        lastResetAt: null,
        currentMonthApiCallCount: 100, // counter (= drift があれば真値と乖離する内部 cache)
        currentMonthApiCostJpy: 1000,
      },
    ] as never);
    vi.mocked(prisma.user.groupBy).mockResolvedValueOnce([
      { tenantId: 'tenant-a', _count: { id: 5 } },
    ] as never);
    // ★ PR-V8.1: ApiCallLog 集計 (真値) は counter と異なる値を返す → これが snapshot に書かれる
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValueOnce({
      _count: { _all: 95 }, // 真値 (counter 100 と乖離 = 5 件 drift)
      _sum: { costJpy: 950 },
    } as never);
    vi.mocked(prisma.tenantMonthlyUsageHistory.upsert).mockResolvedValue({} as never);

    // 2026-05-15 09:00 JST 時点で「前月 = 2026-04」を期待
    await saveMonthlyUsageSnapshots(new Date('2026-05-15T00:00:00Z'));

    // ★ snapshot には ApiCallLog SUM (95 件 / ¥950) が書かれる (counter 値 100/¥1000 ではない)
    expect(prisma.tenantMonthlyUsageHistory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_yearMonth: { tenantId: 'tenant-a', yearMonth: '2026-04' } },
        create: expect.objectContaining({
          tenantId: 'tenant-a',
          yearMonth: '2026-04',
          apiCallCount: 95, // ★ SUM
          apiCostJpy: 950, // ★ SUM
          plan: 'expert',
          activeUserCount: 5,
        }),
      }),
    );

    // ApiCallLog.aggregate が「前月分の TZ 月初範囲」で呼ばれる
    expect(prisma.apiCallLog.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-a',
          createdAt: expect.objectContaining({
            gte: expect.any(Date), // 前月初 (JST)
            lt: expect.any(Date), // 当月初 (JST)
          }),
        }),
      }),
    );
  });

  it('対象 0 件なら upsert を呼ばず 0 を返す', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([] as never);

    const saved = await saveMonthlyUsageSnapshots();

    expect(saved).toBe(0);
    expect(prisma.user.groupBy).not.toHaveBeenCalled();
    expect(prisma.tenantMonthlyUsageHistory.upsert).not.toHaveBeenCalled();
  });

  it('1 件失敗しても他テナントの snapshot は継続 (recordError で記録)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      {
        id: 'tenant-a',
        plan: 'beginner',
        timezone: 'Asia/Tokyo',
        lastResetAt: null,
        currentMonthApiCallCount: 1,
        currentMonthApiCostJpy: 0,
      },
      {
        id: 'tenant-b',
        plan: 'pro',
        timezone: 'Asia/Tokyo',
        lastResetAt: null,
        currentMonthApiCallCount: 2,
        currentMonthApiCostJpy: 60,
      },
      {
        id: 'tenant-c',
        plan: 'expert',
        timezone: 'Asia/Tokyo',
        lastResetAt: null,
        currentMonthApiCallCount: 3,
        currentMonthApiCostJpy: 30,
      },
    ] as never);
    vi.mocked(prisma.user.groupBy).mockResolvedValueOnce([] as never);
    vi.mocked(prisma.tenantMonthlyUsageHistory.upsert)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error('DB write failed'))
      .mockResolvedValueOnce({} as never);

    const saved = await saveMonthlyUsageSnapshots();

    expect(saved).toBe(2); // a と c は成功、b は失敗
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        source: 'cron',
        message: 'DB write failed',
        context: expect.objectContaining({
          kind: 'tenant_monthly_snapshot',
          tenantId: 'tenant-b',
        }),
      }),
    );
  });

  it('アクティブユーザがいないテナントも snapshot 対象 (activeUserCount=0)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      {
        id: 'tenant-a',
        plan: 'beginner',
        timezone: 'Asia/Tokyo',
        lastResetAt: null,
        currentMonthApiCallCount: 0,
        currentMonthApiCostJpy: 0,
      },
    ] as never);
    vi.mocked(prisma.user.groupBy).mockResolvedValueOnce([] as never); // 該当 0 件
    vi.mocked(prisma.tenantMonthlyUsageHistory.upsert).mockResolvedValue({} as never);

    await saveMonthlyUsageSnapshots(new Date('2026-05-01T00:00:00Z'));

    expect(prisma.tenantMonthlyUsageHistory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          activeUserCount: 0,
        }),
      }),
    );
  });
});
