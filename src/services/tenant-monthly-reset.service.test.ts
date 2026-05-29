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
      // ADR-0020 (2026-05-25): billOneTenantDbCapacityOverage 用
      create: vi.fn(() => Promise.resolve({ id: 'mock-log-id' })),
    },
    // ADR-0020: StripeUsageRecordQueue enqueue 用
    stripeUsageRecordQueue: {
      create: vi.fn(() => Promise.resolve({ id: 'mock-queue-id' })),
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
  billOneTenantDbCapacityOverage,
  // ADR-0025 (2026-05-29 3 巡目): File Storage 側 Beginner skip テスト追加用
  billOneTenantFileStorageOverage,
} from './tenant-monthly-reset.service';
import { prisma } from '@/lib/db';
import { recordError } from '@/services/error-log.service';
import { SI_GB_BYTES, SI_MB_BYTES } from '@/config/db-capacity-pricing';

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
  it('processDbCapacityOverage → snapshot → reset → apply の順で実行し、結果を集計して返す', async () => {
    // ADR-0020 (2026-05-25): runTenantMonthlyReset は内部で
    //   processTenantDbCapacityOverage → saveMonthlyUsageSnapshots →
    //   resetTenantMonthlyCounters → applyScheduledPlanChanges → ...
    //   の順で呼ぶ。各ステップは別々の findMany 呼出になるので順序通りにモックを準備。

    // 0. processTenantDbCapacityOverage: 全テナント無料枠内 (peak=0) → ApiCallLog INSERT なし
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      {
        id: 'tenant-a',
        timezone: 'Asia/Tokyo',
        lastResetAt: null,
        storageBytesUsed: BigInt(0),
        storageBytesPeakThisMonth: BigInt(0),
      },
      {
        id: 'tenant-b',
        timezone: 'Asia/Tokyo',
        lastResetAt: null,
        storageBytesUsed: BigInt(0),
        storageBytesPeakThisMonth: BigInt(0),
      },
    ] as never);
    // $transaction は処理を実行するモック (peak=0 なら ApiCallLog INSERT なし、peak reset のみ)
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: unknown) => {
      if (typeof fn === 'function') {
        return await fn({
          tenant: { update: vi.fn() },
          apiCallLog: { create: vi.fn() },
          stripeUsageRecordQueue: { create: vi.fn() },
          auditLog: { create: vi.fn() },
          user: { findFirst: vi.fn(() => Promise.resolve(null)) },
        });
      }
      return fn;
    }) as never);

    // 0-b. processTenantFileStorageOverage (ADR-0021): peak=0 のテナントを返す → ApiCallLog INSERT なし
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      {
        id: 'tenant-a',
        timezone: 'Asia/Tokyo',
        lastResetAt: null,
        storageFileBytesUsed: BigInt(0),
        storageFileBytesPeakThisMonth: BigInt(0),
      },
      {
        id: 'tenant-b',
        timezone: 'Asia/Tokyo',
        lastResetAt: null,
        storageFileBytesUsed: BigInt(0),
        storageFileBytesPeakThisMonth: BigInt(0),
      },
    ] as never);

    // 1. saveMonthlyUsageSnapshots: 対象 2 件
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

    // 2. resetTenantMonthlyCounters (PR-4: findMany + 個別 update に変更)
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      { id: 'tenant-a', timezone: 'Asia/Tokyo', lastResetAt: null },
      { id: 'tenant-b', timezone: 'Asia/Tokyo', lastResetAt: null },
      { id: 'tenant-c', timezone: 'Asia/Tokyo', lastResetAt: null },
      { id: 'tenant-d', timezone: 'Asia/Tokyo', lastResetAt: null },
      { id: 'tenant-e', timezone: 'Asia/Tokyo', lastResetAt: null },
    ] as never);
    vi.mocked(prisma.tenant.update).mockResolvedValue({} as never);

    // 3. applyScheduledPlanChanges
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
      purgedTenantCount: 0,
      purgedRowCount: 0,
      // 2026-05-14: 縮退モード確定仕様 — runMonthlyEmbeddingBackfill のスタブが空を返す
      embeddingBackfillTenantCount: 0,
      embeddingBackfillGeneratedCount: 0,
      // ADR-0020 (2026-05-25): 全テナント無料枠内 → 課金 0
      dbCapacityBilledTenantCount: 0,
      dbCapacityBilledTotalJpy: 0,
      // ADR-0021 (2026-05-26): 全テナント無料枠内 → 課金 0
      fileStorageBilledTenantCount: 0,
      fileStorageBilledTotalJpy: 0,
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
        storageBytesUsed: BigInt(0),
      },
      {
        id: 'tenant-b',
        plan: 'pro',
        timezone: 'Asia/Tokyo',
        lastResetAt: null,
        currentMonthApiCallCount: 1200,
        currentMonthApiCostJpy: 36000,
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

describe('billOneTenantDbCapacityOverage (ADR-0020 / 2026-05-25)', () => {
  const TENANT_ID = '11111111-1111-1111-1111-111111111111';
  const NOW = new Date('2026-06-01T00:00:00Z');

  beforeEach(() => {
    vi.clearAllMocks();
    // $transaction を tx callback として実行 (passthrough mock)
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: unknown) => {
      if (typeof fn === 'function') {
        return await fn({
          tenant: {
            update: vi.fn(() => Promise.resolve({})),
            // ADR-0025 (2026-05-29): Beginner plan 判定で必須。default は Expert で既存挙動維持
            findFirst: vi.fn(() => Promise.resolve({ plan: 'expert' })),
          },
          apiCallLog: { create: vi.fn(() => Promise.resolve({ id: 'mock-log-id' })) },
          stripeUsageRecordQueue: { create: vi.fn(() => Promise.resolve({ id: 'mock-q' })) },
          auditLog: { create: vi.fn(() => Promise.resolve({})) },
          user: { findFirst: vi.fn(() => Promise.resolve(null)) },
        });
      }
      return fn;
    }) as never);
  });

  it('無料枠内 (peak=10MB) → 課金なし (billedJpy=0)', async () => {
    const result = await billOneTenantDbCapacityOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageBytesUsed: BigInt(10 * SI_MB_BYTES),
      storageBytesPeakThisMonth: BigInt(10 * SI_MB_BYTES),
      billingScope: 'previous-month',
      now: NOW,
    });
    expect(result.billedJpy).toBe(0);
    expect(result.apiCallLogId).toBeNull();
  });

  it('51MB (= tier 1 開始) → ¥50 課金', async () => {
    const result = await billOneTenantDbCapacityOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageBytesUsed: BigInt(51 * SI_MB_BYTES),
      storageBytesPeakThisMonth: BigInt(51 * SI_MB_BYTES),
      billingScope: 'previous-month',
      now: NOW,
    });
    expect(result.billedJpy).toBe(50);
    expect(result.apiCallLogId).toBe('mock-log-id');
  });

  it('1GB (= 950MB billable, tier 1 上限) → ¥50', async () => {
    const result = await billOneTenantDbCapacityOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageBytesUsed: BigInt(SI_GB_BYTES),
      storageBytesPeakThisMonth: BigInt(SI_GB_BYTES),
      billingScope: 'previous-month',
      now: NOW,
    });
    expect(result.billedJpy).toBe(50);
  });

  it('50GB (= ハードキャップ peak) → ¥2,500 (tier 50)', async () => {
    const result = await billOneTenantDbCapacityOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageBytesUsed: BigInt(50 * SI_GB_BYTES),
      storageBytesPeakThisMonth: BigInt(50 * SI_GB_BYTES),
      billingScope: 'previous-month',
      now: NOW,
    });
    expect(result.billedJpy).toBe(2500);
  });

  it('billingScope=previous-month は前月末瞬間を createdAt とする (snapshot SUM 範囲内)', async () => {
    let capturedCreatedAt: Date | undefined;
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: unknown) => {
      if (typeof fn === 'function') {
        return await fn({
          tenant: {
            update: vi.fn(() => Promise.resolve({})),
            findFirst: vi.fn(() => Promise.resolve({ plan: 'expert' })),
          },
          apiCallLog: {
            create: vi.fn((args: { data: { createdAt: Date } }) => {
              capturedCreatedAt = args.data.createdAt;
              return Promise.resolve({ id: 'mock-log-id' });
            }),
          },
          stripeUsageRecordQueue: { create: vi.fn(() => Promise.resolve({ id: 'mock-q' })) },
          auditLog: { create: vi.fn(() => Promise.resolve({})) },
          user: { findFirst: vi.fn(() => Promise.resolve(null)) },
        });
      }
      return fn;
    }) as never);

    await billOneTenantDbCapacityOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageBytesUsed: BigInt(100 * SI_MB_BYTES),
      storageBytesPeakThisMonth: BigInt(100 * SI_MB_BYTES),
      billingScope: 'previous-month',
      now: NOW,
    });
    // 2026-06-01 00:00 JST = 2026-05-31 15:00 UTC → 前月末瞬間 = 2026-05-31 14:59:59.999 UTC
    expect(capturedCreatedAt).toBeDefined();
    expect(capturedCreatedAt!.getTime()).toBeLessThan(NOW.getTime());
  });

  it('billingScope=current-month-on-withdrawal は now を createdAt とする (退会時即時請求)', async () => {
    let capturedCreatedAt: Date | undefined;
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: unknown) => {
      if (typeof fn === 'function') {
        return await fn({
          tenant: {
            update: vi.fn(() => Promise.resolve({})),
            findFirst: vi.fn(() => Promise.resolve({ plan: 'expert' })),
          },
          apiCallLog: {
            create: vi.fn((args: { data: { createdAt: Date; requestId: string } }) => {
              capturedCreatedAt = args.data.createdAt;
              expect(args.data.requestId).toContain('-withdraw');
              return Promise.resolve({ id: 'mock-log-id' });
            }),
          },
          stripeUsageRecordQueue: { create: vi.fn(() => Promise.resolve({ id: 'mock-q' })) },
          auditLog: { create: vi.fn(() => Promise.resolve({})) },
          user: { findFirst: vi.fn(() => Promise.resolve(null)) },
        });
      }
      return fn;
    }) as never);

    await billOneTenantDbCapacityOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageBytesUsed: BigInt(100 * SI_MB_BYTES),
      storageBytesPeakThisMonth: BigInt(100 * SI_MB_BYTES),
      billingScope: 'current-month-on-withdrawal',
      now: NOW,
    });
    expect(capturedCreatedAt).toEqual(NOW);
  });

  it('billing invariant: ApiCallLog.costJpy = Stripe Queue.quantity (R6 案 A)', async () => {
    let capturedLogCost: number | undefined;
    let capturedQueueQty: number | undefined;
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: unknown) => {
      if (typeof fn === 'function') {
        return await fn({
          tenant: {
            update: vi.fn(() => Promise.resolve({})),
            findFirst: vi.fn(() => Promise.resolve({ plan: 'expert' })),
          },
          apiCallLog: {
            create: vi.fn((args: { data: { costJpy: number } }) => {
              capturedLogCost = args.data.costJpy;
              return Promise.resolve({ id: 'mock-log-id' });
            }),
          },
          stripeUsageRecordQueue: {
            create: vi.fn((args: { data: { quantity: number } }) => {
              capturedQueueQty = args.data.quantity;
              return Promise.resolve({ id: 'mock-q' });
            }),
          },
          auditLog: { create: vi.fn(() => Promise.resolve({})) },
          user: { findFirst: vi.fn(() => Promise.resolve(null)) },
        });
      }
      return fn;
    }) as never);

    await billOneTenantDbCapacityOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageBytesUsed: BigInt(2050 * SI_MB_BYTES), // tier 2 上限
      storageBytesPeakThisMonth: BigInt(2050 * SI_MB_BYTES),
      billingScope: 'previous-month',
      now: NOW,
    });
    // tier 2 = ¥100、quantity = ¥100 整数で完全一致
    expect(capturedLogCost).toBe(100);
    expect(capturedQueueQty).toBe(100);
    expect(capturedLogCost).toBe(capturedQueueQty);
  });
});

// ================================================================
// ADR-0025 (2026-05-29): Beginner プラン overage 課金 skip
// ================================================================

describe('ADR-0025: Beginner プラン overage skip — billOneTenantDbCapacityOverage', () => {
  const TENANT_ID = '11111111-1111-1111-1111-111111111111';
  const NOW = new Date('2026-06-01T00:00:00Z');

  let apiCallLogCreateMock: ReturnType<typeof vi.fn>;
  let tenantUpdateMock: ReturnType<typeof vi.fn>;
  let stripeQueueCreateMock: ReturnType<typeof vi.fn>;
  let auditLogCreateMock: ReturnType<typeof vi.fn>;

  function setupMockWithPlan(plan: 'beginner' | 'expert' | 'pro') {
    apiCallLogCreateMock = vi.fn(() => Promise.resolve({ id: 'mock-log-id' }));
    tenantUpdateMock = vi.fn(() => Promise.resolve({}));
    stripeQueueCreateMock = vi.fn(() => Promise.resolve({ id: 'mock-q' }));
    auditLogCreateMock = vi.fn(() => Promise.resolve({}));
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: unknown) => {
      if (typeof fn === 'function') {
        return await fn({
          tenant: {
            update: tenantUpdateMock,
            findFirst: vi.fn(() => Promise.resolve({ plan })),
          },
          apiCallLog: { create: apiCallLogCreateMock },
          stripeUsageRecordQueue: { create: stripeQueueCreateMock },
          auditLog: { create: auditLogCreateMock },
          user: { findFirst: vi.fn(() => Promise.resolve({ id: 'system-user' })) },
        });
      }
      return fn;
    }) as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Beginner × 51MB 超 → ApiCallLog 未 INSERT (billedJpy=0)', async () => {
    setupMockWithPlan('beginner');
    const result = await billOneTenantDbCapacityOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageBytesUsed: BigInt(51 * SI_MB_BYTES),
      storageBytesPeakThisMonth: BigInt(51 * SI_MB_BYTES),
      billingScope: 'previous-month',
      now: NOW,
    });
    expect(result.billedJpy).toBe(0);
    expect(result.apiCallLogId).toBeNull();
    expect(apiCallLogCreateMock).not.toHaveBeenCalled();
    expect(stripeQueueCreateMock).not.toHaveBeenCalled();
  });

  it('Beginner × 51MB 超 → audit_log で skip 証跡を残す (entityType=api_call_log_skip)', async () => {
    setupMockWithPlan('beginner');
    await billOneTenantDbCapacityOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageBytesUsed: BigInt(2 * SI_GB_BYTES),
      storageBytesPeakThisMonth: BigInt(2 * SI_GB_BYTES),
      billingScope: 'previous-month',
      now: NOW,
    });
    expect(auditLogCreateMock).toHaveBeenCalledTimes(1);
    const auditCall = auditLogCreateMock.mock.calls[0]?.[0] as {
      data: {
        entityType: string;
        entityId: string;
        afterValue: {
          adr: string;
          skipReason: string;
          costJpy: number;
          calculatedCostJpyIfBilled: number;
          requestId: string;
        };
      };
    };
    expect(auditCall.data.entityType).toBe('api_call_log_skip');
    // ADR-0025 (2026-05-29 修正): entityId は @db.Uuid 型のため tenantId を入れる
    //   (旧実装の requestId='db-capacity-overage-{tenantId}-{ym}-{scope}' は UUID 型違反で
    //    production の PostgreSQL で reject されていた)
    expect(auditCall.data.entityId).toBe(TENANT_ID);
    // requestId は afterValue 経由で識別子として保持
    expect(auditCall.data.afterValue.requestId).toContain('db-capacity-overage');
    expect(auditCall.data.afterValue.requestId).toContain(TENANT_ID);
    expect(auditCall.data.afterValue.adr).toBe('ADR-0025');
    expect(auditCall.data.afterValue.skipReason).toContain('beginner');
    expect(auditCall.data.afterValue.costJpy).toBe(0);
    expect(auditCall.data.afterValue.calculatedCostJpyIfBilled).toBe(100); // 2GB tier = ¥100
  });

  it('Expert × 51MB 超 → 既存通り課金 (billedJpy=50)', async () => {
    setupMockWithPlan('expert');
    const result = await billOneTenantDbCapacityOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageBytesUsed: BigInt(51 * SI_MB_BYTES),
      storageBytesPeakThisMonth: BigInt(51 * SI_MB_BYTES),
      billingScope: 'previous-month',
      now: NOW,
    });
    expect(result.billedJpy).toBe(50);
    expect(result.apiCallLogId).toBe('mock-log-id');
    expect(apiCallLogCreateMock).toHaveBeenCalledTimes(1);
    expect(stripeQueueCreateMock).toHaveBeenCalledTimes(1);
  });

  it('Pro × 51MB 超 → 既存通り課金 (billedJpy=50)', async () => {
    setupMockWithPlan('pro');
    const result = await billOneTenantDbCapacityOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageBytesUsed: BigInt(51 * SI_MB_BYTES),
      storageBytesPeakThisMonth: BigInt(51 * SI_MB_BYTES),
      billingScope: 'previous-month',
      now: NOW,
    });
    expect(result.billedJpy).toBe(50);
    expect(apiCallLogCreateMock).toHaveBeenCalled();
  });

  it('Beginner × 無料枠内 (10MB) → audit_log なし (= costJpy=0 で if 条件未通過)', async () => {
    setupMockWithPlan('beginner');
    const result = await billOneTenantDbCapacityOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageBytesUsed: BigInt(10 * SI_MB_BYTES),
      storageBytesPeakThisMonth: BigInt(10 * SI_MB_BYTES),
      billingScope: 'previous-month',
      now: NOW,
    });
    expect(result.billedJpy).toBe(0);
    expect(auditLogCreateMock).not.toHaveBeenCalled();
  });
});

// ================================================================
// ADR-0025 (2026-05-29 3 巡目): File Storage 側 Beginner skip テスト
// = DB capacity と対称、片肺テスト解消 (3 巡目検証 §E.1)
// ================================================================

describe('ADR-0025: Beginner プラン overage skip — billOneTenantFileStorageOverage', () => {
  const TENANT_ID = '11111111-1111-1111-1111-111111111111';
  const NOW = new Date('2026-06-01T00:00:00Z');

  let apiCallLogCreateMock: ReturnType<typeof vi.fn>;
  let tenantUpdateMock: ReturnType<typeof vi.fn>;
  let stripeQueueCreateMock: ReturnType<typeof vi.fn>;
  let auditLogCreateMock: ReturnType<typeof vi.fn>;

  function setupMockWithPlan(plan: 'beginner' | 'expert' | 'pro') {
    apiCallLogCreateMock = vi.fn(() => Promise.resolve({ id: 'mock-log-id' }));
    tenantUpdateMock = vi.fn(() => Promise.resolve({}));
    stripeQueueCreateMock = vi.fn(() => Promise.resolve({ id: 'mock-q' }));
    auditLogCreateMock = vi.fn(() => Promise.resolve({}));
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: unknown) => {
      if (typeof fn === 'function') {
        return await fn({
          tenant: {
            update: tenantUpdateMock,
            findFirst: vi.fn(() => Promise.resolve({ plan })),
          },
          apiCallLog: { create: apiCallLogCreateMock },
          stripeUsageRecordQueue: { create: stripeQueueCreateMock },
          auditLog: { create: auditLogCreateMock },
          user: { findFirst: vi.fn(() => Promise.resolve({ id: 'system-user' })) },
        });
      }
      return fn;
    }) as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Beginner × 101MB 超 → ApiCallLog 未 INSERT (billedJpy=0)', async () => {
    setupMockWithPlan('beginner');
    const result = await billOneTenantFileStorageOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageFileBytesUsed: BigInt(101 * SI_MB_BYTES),
      storageFileBytesPeakThisMonth: BigInt(101 * SI_MB_BYTES),
      billingScope: 'previous-month',
      now: NOW,
    });
    expect(result.billedJpy).toBe(0);
    expect(result.apiCallLogId).toBeNull();
    expect(apiCallLogCreateMock).not.toHaveBeenCalled();
    expect(stripeQueueCreateMock).not.toHaveBeenCalled();
  });

  it('Beginner × 2GB 超 → audit_log で skip 証跡 (entityId=tenantId UUID、ADR-0025 修正点)', async () => {
    setupMockWithPlan('beginner');
    await billOneTenantFileStorageOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageFileBytesUsed: BigInt(2 * SI_GB_BYTES),
      storageFileBytesPeakThisMonth: BigInt(2 * SI_GB_BYTES),
      billingScope: 'previous-month',
      now: NOW,
    });
    expect(auditLogCreateMock).toHaveBeenCalledTimes(1);
    const auditCall = auditLogCreateMock.mock.calls[0]?.[0] as {
      data: {
        entityType: string;
        entityId: string;
        afterValue: {
          featureUnit: string;
          adr: string;
          skipReason: string;
          costJpy: number;
          calculatedCostJpyIfBilled: number;
          requestId: string;
        };
      };
    };
    expect(auditCall.data.entityType).toBe('api_call_log_skip');
    // ADR-0025 (2026-05-29 修正): entityId は UUID 型のため tenantId
    expect(auditCall.data.entityId).toBe(TENANT_ID);
    expect(auditCall.data.afterValue.featureUnit).toBe('storage-file-overage');
    expect(auditCall.data.afterValue.adr).toBe('ADR-0025');
    expect(auditCall.data.afterValue.skipReason).toContain('beginner');
    expect(auditCall.data.afterValue.costJpy).toBe(0);
    expect(auditCall.data.afterValue.calculatedCostJpyIfBilled).toBe(20); // 2GB tier × ¥10 = ¥20
    expect(auditCall.data.afterValue.requestId).toContain('storage-file-overage');
    expect(auditCall.data.afterValue.requestId).toContain(TENANT_ID);
  });

  it('Expert × 101MB 超 → 既存通り課金 (billedJpy=10)', async () => {
    setupMockWithPlan('expert');
    const result = await billOneTenantFileStorageOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageFileBytesUsed: BigInt(101 * SI_MB_BYTES),
      storageFileBytesPeakThisMonth: BigInt(101 * SI_MB_BYTES),
      billingScope: 'previous-month',
      now: NOW,
    });
    expect(result.billedJpy).toBe(10);
    expect(result.apiCallLogId).toBe('mock-log-id');
    expect(apiCallLogCreateMock).toHaveBeenCalledTimes(1);
    expect(stripeQueueCreateMock).toHaveBeenCalledTimes(1);
  });

  it('Pro × 101MB 超 → 既存通り課金 (billedJpy=10)', async () => {
    setupMockWithPlan('pro');
    const result = await billOneTenantFileStorageOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageFileBytesUsed: BigInt(101 * SI_MB_BYTES),
      storageFileBytesPeakThisMonth: BigInt(101 * SI_MB_BYTES),
      billingScope: 'previous-month',
      now: NOW,
    });
    expect(result.billedJpy).toBe(10);
    expect(apiCallLogCreateMock).toHaveBeenCalled();
  });

  it('Beginner × 無料枠内 (50MB) → audit_log なし (costJpy=0 で skip path 未通過)', async () => {
    setupMockWithPlan('beginner');
    const result = await billOneTenantFileStorageOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageFileBytesUsed: BigInt(50 * SI_MB_BYTES),
      storageFileBytesPeakThisMonth: BigInt(50 * SI_MB_BYTES),
      billingScope: 'previous-month',
      now: NOW,
    });
    expect(result.billedJpy).toBe(0);
    expect(auditLogCreateMock).not.toHaveBeenCalled();
  });

  it('Beginner × 退会時即時請求 (current-month-on-withdrawal) でも skip', async () => {
    setupMockWithPlan('beginner');
    const result = await billOneTenantFileStorageOverage({
      tenantId: TENANT_ID,
      timezone: 'Asia/Tokyo',
      storageFileBytesUsed: BigInt(500 * SI_MB_BYTES),
      storageFileBytesPeakThisMonth: BigInt(500 * SI_MB_BYTES),
      billingScope: 'current-month-on-withdrawal',
      now: NOW,
    });
    // ADR-0025: 退会時も Beginner は課金 skip (= 解約時の最後の課金が発生しない)
    expect(result.billedJpy).toBe(0);
    expect(apiCallLogCreateMock).not.toHaveBeenCalled();
    expect(stripeQueueCreateMock).not.toHaveBeenCalled();
  });
});
