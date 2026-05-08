/**
 * super_admin サービスの単体テスト
 *
 * 検証項目:
 *   - listMonthlyUsageHistory (P-5b): 過去 N ヶ月の yearMonth を生成して history を取得
 *   - listDormantTenants (P-6): 90 日以上活動のないテナントの抽出
 *   - DTO 整形
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenantMonthlyUsageHistory: {
      findMany: vi.fn(),
    },
    // P-6 (2026-05-08): listDormantTenants で使用
    tenant: {
      findMany: vi.fn(),
    },
    user: {
      groupBy: vi.fn(),
    },
  },
}));

import {
  listMonthlyUsageHistory,
  listDormantTenants,
  DORMANT_TENANT_THRESHOLD_DAYS,
} from './super-admin.service';
import { prisma } from '@/lib/db';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listMonthlyUsageHistory (P-5b / 2026-05-08)', () => {
  it('履歴行をテナント情報と結合して DTO 形式で返す', async () => {
    vi.mocked(prisma.tenantMonthlyUsageHistory.findMany).mockResolvedValueOnce([
      {
        yearMonth: '2026-04',
        tenantId: 'tenant-a',
        plan: 'expert',
        apiCallCount: 250,
        apiCostJpy: 2500,
        activeUserCount: 4,
        tenant: { tenantSeq: 2, name: 'カスタマーA' },
      },
      {
        yearMonth: '2026-04',
        tenantId: 'tenant-b',
        plan: 'pro',
        apiCallCount: 1500,
        apiCostJpy: 45000,
        activeUserCount: 12,
        tenant: { tenantSeq: 3, name: 'カスタマーB' },
      },
    ] as never);

    const rows = await listMonthlyUsageHistory(6);

    expect(rows).toEqual([
      {
        yearMonth: '2026-04',
        tenantId: 'tenant-a',
        tenantSeq: 2,
        tenantName: 'カスタマーA',
        plan: 'expert',
        apiCallCount: 250,
        apiCostJpy: 2500,
        activeUserCount: 4,
      },
      {
        yearMonth: '2026-04',
        tenantId: 'tenant-b',
        tenantSeq: 3,
        tenantName: 'カスタマーB',
        plan: 'pro',
        apiCallCount: 1500,
        apiCostJpy: 45000,
        activeUserCount: 12,
      },
    ]);
  });

  it('months=6 で過去 6 ヶ月の yearMonth を IN 句に渡す (当月含まない)', async () => {
    vi.mocked(prisma.tenantMonthlyUsageHistory.findMany).mockResolvedValueOnce([] as never);

    await listMonthlyUsageHistory(6);

    const callArg = vi.mocked(prisma.tenantMonthlyUsageHistory.findMany).mock.calls[0]![0];
    const targetYearMonths = (callArg as { where: { yearMonth: { in: string[] } } })
      .where.yearMonth.in;
    // 過去 6 ヶ月分 (当月含まず) = 6 件
    expect(targetYearMonths).toHaveLength(6);
    // 全要素が "YYYY-MM" 形式
    targetYearMonths.forEach((ym) => {
      expect(ym).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    });
  });

  it('months 引数のクランプ: 0 以下なら 1 件、25 以上なら 24 件', async () => {
    vi.mocked(prisma.tenantMonthlyUsageHistory.findMany).mockResolvedValue([] as never);

    await listMonthlyUsageHistory(0);
    let callArg = vi.mocked(prisma.tenantMonthlyUsageHistory.findMany).mock.calls.at(-1)![0];
    let in1 = (callArg as { where: { yearMonth: { in: string[] } } }).where.yearMonth.in;
    expect(in1).toHaveLength(1);

    await listMonthlyUsageHistory(-5);
    callArg = vi.mocked(prisma.tenantMonthlyUsageHistory.findMany).mock.calls.at(-1)![0];
    in1 = (callArg as { where: { yearMonth: { in: string[] } } }).where.yearMonth.in;
    expect(in1).toHaveLength(1);

    await listMonthlyUsageHistory(100);
    callArg = vi.mocked(prisma.tenantMonthlyUsageHistory.findMany).mock.calls.at(-1)![0];
    in1 = (callArg as { where: { yearMonth: { in: string[] } } }).where.yearMonth.in;
    expect(in1).toHaveLength(24);
  });

  it('履歴 0 件なら空配列', async () => {
    vi.mocked(prisma.tenantMonthlyUsageHistory.findMany).mockResolvedValueOnce([] as never);

    const rows = await listMonthlyUsageHistory(6);
    expect(rows).toEqual([]);
  });
});

describe('listDormantTenants (P-6 / 2026-05-08)', () => {
  // 固定された "今" を使ってテストの再現性を確保
  const NOW = new Date('2026-05-08T12:00:00Z');
  const day = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

  it('閾値 (90 日) 内に最終ログインがあったテナントは除外される', async () => {
    // tenant-a (60 日前ログイン) は活動中、tenant-b (100 日前) は休眠
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      { id: 'tenant-a', tenantSeq: 2, name: '活動中', plan: 'expert', createdAt: day(200) },
      { id: 'tenant-b', tenantSeq: 3, name: '休眠中', plan: 'beginner', createdAt: day(200) },
    ] as never);
    vi.mocked(prisma.user.groupBy).mockResolvedValueOnce([
      { tenantId: 'tenant-a', _max: { lastLoginAt: day(60) } },
      { tenantId: 'tenant-b', _max: { lastLoginAt: day(100) } },
    ] as never);

    const rows = await listDormantTenants(90, NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('tenant-b');
    expect(rows[0]?.daysSinceLastActivity).toBe(100);
  });

  it('テナント内全員が一度もログインしていなければ createdAt 起点で判定', async () => {
    // tenant-c は 200 日前作成 + 誰もログイン未経験 → 休眠 200 日
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      { id: 'tenant-c', tenantSeq: 5, name: '無活動', plan: 'beginner', createdAt: day(200) },
    ] as never);
    vi.mocked(prisma.user.groupBy).mockResolvedValueOnce([
      { tenantId: 'tenant-c', _max: { lastLoginAt: null } },
    ] as never);

    const rows = await listDormantTenants(90, NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastUserLoginAt).toBeNull();
    expect(rows[0]?.daysSinceLastActivity).toBe(200);
  });

  it('新規 onboarding 期間 (createdAt が閾値内) は休眠判定対象外', async () => {
    // tenant-d は 30 日前作成 (= onboarding 中) → findMany の段階で除外される想定
    // findMany の where が createdAt: { lte: cutoffDate } を含むので、Prisma が事前に弾く
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([] as never);

    const rows = await listDormantTenants(90, NOW);

    expect(rows).toHaveLength(0);
    // findMany の where に createdAt の制約が入る (onboarding 期間除外)
    const callArg = vi.mocked(prisma.tenant.findMany).mock.calls[0]![0];
    expect(callArg).toMatchObject({
      where: expect.objectContaining({
        createdAt: expect.objectContaining({ lte: expect.any(Date) }),
      }),
    });
  });

  it('管理テナントは除外する (id != MANAGEMENT_TENANT_ID)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([] as never);

    await listDormantTenants(90, NOW);

    const callArg = vi.mocked(prisma.tenant.findMany).mock.calls[0]![0];
    expect(callArg).toMatchObject({
      where: expect.objectContaining({
        id: { not: '00000000-0000-0000-0000-ffffffffffff' },
        deletedAt: null,
      }),
    });
  });

  it('複数の休眠テナントは休眠日数降順で並ぶ', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      { id: 'tenant-a', tenantSeq: 2, name: '100日休眠', plan: 'expert', createdAt: day(200) },
      { id: 'tenant-b', tenantSeq: 3, name: '300日休眠', plan: 'beginner', createdAt: day(400) },
      { id: 'tenant-c', tenantSeq: 4, name: '150日休眠', plan: 'pro', createdAt: day(200) },
    ] as never);
    vi.mocked(prisma.user.groupBy).mockResolvedValueOnce([
      { tenantId: 'tenant-a', _max: { lastLoginAt: day(100) } },
      { tenantId: 'tenant-b', _max: { lastLoginAt: day(300) } },
      { tenantId: 'tenant-c', _max: { lastLoginAt: day(150) } },
    ] as never);

    const rows = await listDormantTenants(90, NOW);

    expect(rows.map((r) => r.name)).toEqual(['300日休眠', '150日休眠', '100日休眠']);
  });

  it('対象テナント 0 件なら空配列 (user.groupBy 呼ばない)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([] as never);

    const rows = await listDormantTenants(90, NOW);

    expect(rows).toEqual([]);
    expect(prisma.user.groupBy).not.toHaveBeenCalled();
  });

  it('しきい値カスタマイズ: 30 日でも休眠判定可能', async () => {
    // 60 日前ログインのテナントは 90 日基準では活動中だが、30 日基準では休眠
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      { id: 'tenant-a', tenantSeq: 2, name: '60日休眠', plan: 'expert', createdAt: day(200) },
    ] as never);
    vi.mocked(prisma.user.groupBy).mockResolvedValueOnce([
      { tenantId: 'tenant-a', _max: { lastLoginAt: day(60) } },
    ] as never);

    const rows = await listDormantTenants(30, NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.daysSinceLastActivity).toBe(60);
  });

  it('DORMANT_TENANT_THRESHOLD_DAYS は 90 日', () => {
    expect(DORMANT_TENANT_THRESHOLD_DAYS).toBe(90);
  });
});
