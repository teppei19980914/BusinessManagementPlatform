/**
 * billing-dashboard.service の単体テスト (PR-V7 #8 / 2026-05-19)
 *
 * 検証観点:
 *   1. getBillingSummary: 空配列 / 単月 / 複数月集計
 *   2. status 別 / paymentMethod 別の集計が正しく振り分けられる
 *   3. 管理テナント (MANAGEMENT_TENANT_ID) が where から除外される
 *   4. getMonthlyBillingDetail: フィルタなし / status / paymentMethod / 両方
 *   5. 解約済テナントも詳細に含まれる (tenantDeletedAt セット)
 *   6. getRecentMonths: 月数 / TZ / 月跨ぎ / 1 月のロールバック
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    billingHistory: {
      groupBy: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db';
import {
  getBillingSummary,
  getMonthlyBillingDetail,
  getRecentMonths,
} from './billing-dashboard.service';

const MANAGEMENT_TENANT_ID = '00000000-0000-0000-0000-ffffffffffff';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getBillingSummary', () => {
  it('yearMonths 空 → 空配列を返す (= prisma 呼出なし)', async () => {
    const result = await getBillingSummary([]);
    expect(result).toEqual([]);
    expect(prisma.billingHistory.groupBy).not.toHaveBeenCalled();
  });

  it('単月 + status 別合計を正しく振り分け', async () => {
    vi.mocked(prisma.billingHistory.groupBy)
      .mockResolvedValueOnce([
        { yearMonth: '2026-06', status: 'paid', _sum: { totalAmountJpy: 120000 }, _count: 4 },
        { yearMonth: '2026-06', status: 'pending', _sum: { totalAmountJpy: 20000 }, _count: 1 },
        { yearMonth: '2026-06', status: 'failed', _sum: { totalAmountJpy: 10000 }, _count: 1 },
      ] as never)
      .mockResolvedValueOnce([
        { yearMonth: '2026-06', paymentMethod: 'credit_card', _count: 3 },
        { yearMonth: '2026-06', paymentMethod: 'invoice', _count: 3 },
      ] as never);

    const [s] = await getBillingSummary(['2026-06']);

    expect(s.yearMonth).toBe('2026-06');
    expect(s.totalAmount).toBe(150000);
    expect(s.paidAmount).toBe(120000);
    expect(s.pendingAmount).toBe(20000);
    expect(s.failedAmount).toBe(10000);
    expect(s.refundedAmount).toBe(0);
    expect(s.canceledAmount).toBe(0);
    expect(s.replacedAmount).toBe(0);
    expect(s.countByStatus).toEqual({ paid: 4, pending: 1, failed: 1 });
    expect(s.countByPaymentMethod).toEqual({ credit_card: 3, invoice: 3 });
  });

  it('複数月 → 新しい順 (yearMonth desc) で返却', async () => {
    vi.mocked(prisma.billingHistory.groupBy)
      .mockResolvedValueOnce([
        { yearMonth: '2026-05', status: 'paid', _sum: { totalAmountJpy: 140000 }, _count: 5 },
        { yearMonth: '2026-06', status: 'paid', _sum: { totalAmountJpy: 120000 }, _count: 4 },
      ] as never)
      .mockResolvedValueOnce([]);

    const result = await getBillingSummary(['2026-05', '2026-06']);

    expect(result.map((s) => s.yearMonth)).toEqual(['2026-06', '2026-05']);
  });

  it('管理テナントは where 句で除外されている', async () => {
    vi.mocked(prisma.billingHistory.groupBy)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    await getBillingSummary(['2026-06']);

    const firstCall = vi.mocked(prisma.billingHistory.groupBy).mock.calls[0]?.[0];
    expect(firstCall?.where).toMatchObject({
      tenantId: { not: MANAGEMENT_TENANT_ID },
    });
  });

  it('refunded / canceled / replaced_by_stripe も対応 status カラムに集計', async () => {
    vi.mocked(prisma.billingHistory.groupBy)
      .mockResolvedValueOnce([
        { yearMonth: '2026-06', status: 'refunded', _sum: { totalAmountJpy: 5000 }, _count: 1 },
        { yearMonth: '2026-06', status: 'canceled', _sum: { totalAmountJpy: 3000 }, _count: 1 },
        { yearMonth: '2026-06', status: 'replaced_by_stripe', _sum: { totalAmountJpy: 2000 }, _count: 1 },
      ] as never)
      .mockResolvedValueOnce([] as never);

    const [s] = await getBillingSummary(['2026-06']);

    expect(s.refundedAmount).toBe(5000);
    expect(s.canceledAmount).toBe(3000);
    expect(s.replacedAmount).toBe(2000);
    expect(s.totalAmount).toBe(10000);
  });
});

describe('getMonthlyBillingDetail', () => {
  it('フィルタなし → 全レコード返却 + tenant 情報結合', async () => {
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValueOnce([
      {
        id: 'bh-1',
        tenantId: 'tenant-1',
        yearMonth: '2026-06',
        paymentMethod: 'credit_card',
        amountJpy: 10000,
        taxAmountJpy: 1000,
        totalAmountJpy: 11000,
        status: 'paid',
        stripeInvoiceId: 'in_xxx',
        paidAt: new Date('2026-06-01'),
        failureReason: null,
        retryCount: 0,
        createdAt: new Date('2026-06-01'),
        updatedAt: new Date('2026-06-01'),
        tenant: {
          id: 'tenant-1',
          name: 'たすき社',
          tenantSeq: 1,
          deletedAt: null,
        },
      },
    ] as never);

    const result = await getMonthlyBillingDetail('2026-06');

    expect(result.length).toBe(1);
    expect(result[0]?.tenantName).toBe('たすき社');
    expect(result[0]?.tenantSeq).toBe(1);
    expect(result[0]?.tenantDeletedAt).toBeNull();
    expect(result[0]?.status).toBe('paid');
  });

  it('status フィルタ指定 → where に追加', async () => {
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValueOnce([] as never);

    await getMonthlyBillingDetail('2026-06', { status: 'failed' });

    const call = vi.mocked(prisma.billingHistory.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ yearMonth: '2026-06', status: 'failed' });
  });

  it('paymentMethod フィルタ指定 → where に追加', async () => {
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValueOnce([] as never);

    await getMonthlyBillingDetail('2026-06', { paymentMethod: 'credit_card' });

    const call = vi.mocked(prisma.billingHistory.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ paymentMethod: 'credit_card' });
  });

  it('両方フィルタ指定 → 両方 where に追加', async () => {
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValueOnce([] as never);

    await getMonthlyBillingDetail('2026-06', { status: 'paid', paymentMethod: 'invoice' });

    const call = vi.mocked(prisma.billingHistory.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({
      status: 'paid',
      paymentMethod: 'invoice',
    });
  });

  it('解約済テナントの履歴も含まれる (= tenantDeletedAt にセットされて返却)', async () => {
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValueOnce([
      {
        id: 'bh-1',
        tenantId: 'tenant-deleted',
        yearMonth: '2026-06',
        paymentMethod: 'credit_card',
        amountJpy: 10000,
        taxAmountJpy: 1000,
        totalAmountJpy: 11000,
        status: 'paid',
        stripeInvoiceId: null,
        paidAt: null,
        failureReason: null,
        retryCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        tenant: {
          id: 'tenant-deleted',
          name: '解約済社',
          tenantSeq: 2,
          deletedAt: new Date('2026-05-15'),
        },
      },
    ] as never);

    const result = await getMonthlyBillingDetail('2026-06');

    expect(result[0]?.tenantDeletedAt).toBeInstanceOf(Date);
  });

  it('管理テナントは where 句で除外されている', async () => {
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValueOnce([] as never);

    await getMonthlyBillingDetail('2026-06');

    const call = vi.mocked(prisma.billingHistory.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({
      tenantId: { not: MANAGEMENT_TENANT_ID },
    });
  });
});

describe('getRecentMonths', () => {
  it('n=6 で 6 ヶ月 (新しい順) 返却', () => {
    const result = getRecentMonths(6, 'Asia/Tokyo', new Date('2026-06-15T03:00:00Z'));
    expect(result).toEqual([
      '2026-06',
      '2026-05',
      '2026-04',
      '2026-03',
      '2026-02',
      '2026-01',
    ]);
  });

  it('年跨ぎ (= 1 月から遡って前年に) を正しく扱う', () => {
    const result = getRecentMonths(3, 'Asia/Tokyo', new Date('2026-02-15T03:00:00Z'));
    expect(result).toEqual(['2026-02', '2026-01', '2025-12']);
  });

  it('1 月の翌月 = その月 + 前年 12 月の境界処理', () => {
    const result = getRecentMonths(2, 'Asia/Tokyo', new Date('2026-01-15T03:00:00Z'));
    expect(result).toEqual(['2026-01', '2025-12']);
  });

  it('n=0 → 空配列', () => {
    expect(getRecentMonths(0)).toEqual([]);
  });

  it('TZ 別: UTC で月末日 (= JST で翌月) なら JST 基準で翌月扱い', () => {
    // 2025-12-31 23:00 UTC = 2026-01-01 08:00 JST
    const result = getRecentMonths(2, 'Asia/Tokyo', new Date('2025-12-31T23:00:00Z'));
    expect(result).toEqual(['2026-01', '2025-12']);
  });
});
