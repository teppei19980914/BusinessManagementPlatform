/**
 * super_admin サービスの単体テスト (P-5b / 2026-05-08 — 履歴クエリのみ)
 *
 * 検証項目:
 *   - listMonthlyUsageHistory: 過去 N ヶ月の yearMonth を生成して history を取得
 *   - months 引数のクランプ (1〜24)
 *   - tenant join + DTO 整形
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenantMonthlyUsageHistory: {
      findMany: vi.fn(),
    },
  },
}));

import { listMonthlyUsageHistory } from './super-admin.service';
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
