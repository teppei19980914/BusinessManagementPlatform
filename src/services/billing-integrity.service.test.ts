/**
 * billing-integrity.service の単体テスト (PR-V8.4 / 2026-05-19)
 *
 * ★請求最終防衛★
 *   BillingHistory の totalAmountJpy = amountJpy + taxAmountJpy 単純和違反 +
 *   消費税四捨五入計算違反 + 負値を検知する。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    billingHistory: {
      findMany: vi.fn(),
    },
  },
}));

import { detectBillingHistoryIntegrityIssues } from './billing-integrity.service';
import { prisma } from '@/lib/db';

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const BH_1 = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('detectBillingHistoryIntegrityIssues', () => {
  it('正常: 単純和 + 消費税四捨五入が一致する行は issue なし', async () => {
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValue([
      {
        id: BH_1,
        tenantId: TENANT_A,
        yearMonth: '2026-05',
        paymentMethod: 'invoice',
        status: 'pending',
        amountJpy: 1000, // 税抜
        taxAmountJpy: 100, // = round(1000 * 0.10)
        totalAmountJpy: 1100, // = 1000 + 100
      },
    ] as never);

    const issues = await detectBillingHistoryIntegrityIssues();
    expect(issues).toEqual([]);
  });

  it('★request invariant 違反★ total != amount + tax → total_mismatch', async () => {
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValue([
      {
        id: BH_1,
        tenantId: TENANT_A,
        yearMonth: '2026-05',
        paymentMethod: 'invoice',
        status: 'pending',
        amountJpy: 1000,
        taxAmountJpy: 100,
        totalAmountJpy: 9999, // ★ 1100 が正解、計算ミス
      },
    ] as never);

    const issues = await detectBillingHistoryIntegrityIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0].issueKinds).toContain('total_mismatch');
    expect(issues[0].expectedTotalAmountJpy).toBe(1100);
    expect(issues[0].storedTotalAmountJpy).toBe(9999);
  });

  it('★消費税計算違反★ tax != round(amount * 0.10) → tax_mismatch', async () => {
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValue([
      {
        id: BH_1,
        tenantId: TENANT_A,
        yearMonth: '2026-05',
        paymentMethod: 'credit_card',
        status: 'paid',
        amountJpy: 1234, // 税抜
        taxAmountJpy: 999, // ★ 123 が正解 (= round(123.4))
        totalAmountJpy: 1234 + 999, // total は和としては整合
      },
    ] as never);

    const issues = await detectBillingHistoryIntegrityIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0].issueKinds).toContain('tax_mismatch');
    expect(issues[0].expectedTaxAmountJpy).toBe(123);
  });

  it('★負値検知★ amountJpy < 0 → negative_amount', async () => {
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValue([
      {
        id: BH_1,
        tenantId: TENANT_A,
        yearMonth: '2026-05',
        paymentMethod: 'invoice',
        status: 'pending',
        amountJpy: -100, // ★ 不正
        taxAmountJpy: -10,
        totalAmountJpy: -110,
      },
    ] as never);

    const issues = await detectBillingHistoryIntegrityIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0].issueKinds).toContain('negative_amount');
    expect(issues[0].issueKinds).toContain('negative_total');
  });

  it('複数違反が同時検出される (total_mismatch + tax_mismatch)', async () => {
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValue([
      {
        id: BH_1,
        tenantId: TENANT_A,
        yearMonth: '2026-05',
        paymentMethod: 'invoice',
        status: 'pending',
        amountJpy: 1000,
        taxAmountJpy: 50, // ★ 100 が正解
        totalAmountJpy: 1234, // ★ 1100 (or 1050) が正解
      },
    ] as never);

    const issues = await detectBillingHistoryIntegrityIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0].issueKinds).toContain('total_mismatch');
    expect(issues[0].issueKinds).toContain('tax_mismatch');
  });

  it("status='canceled' / 'replaced_by_stripe' は走査対象外 (意図的不一致を許容)", async () => {
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValue([] as never);

    await detectBillingHistoryIntegrityIssues();

    expect(prisma.billingHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { notIn: ['canceled', 'replaced_by_stripe'] },
        }),
      }),
    );
  });

  it('monthsBack=6 (default) で過去 6 ヶ月の yearMonth を生成', async () => {
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValue([] as never);

    await detectBillingHistoryIntegrityIssues(6, new Date('2026-05-19T00:00:00Z'));

    const call = vi.mocked(prisma.billingHistory.findMany).mock.calls[0]![0]!;
    const yearMonths = (call.where as { yearMonth: { in: string[] } }).yearMonth.in;
    expect(yearMonths).toEqual([
      '2026-05',
      '2026-04',
      '2026-03',
      '2026-02',
      '2026-01',
      '2025-12',
    ]);
  });

  it('AMOUNT_RECONCILE_TOLERANCE_JPY=1 以内の差分は許容', async () => {
    // amount=1234, tax=124 (round=123 期待) → 差 1 円は許容
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValue([
      {
        id: BH_1,
        tenantId: TENANT_A,
        yearMonth: '2026-05',
        paymentMethod: 'invoice',
        status: 'pending',
        amountJpy: 1234,
        taxAmountJpy: 124, // 期待 123, 差 1
        totalAmountJpy: 1358, // 期待 1357, 差 1
      },
    ] as never);

    const issues = await detectBillingHistoryIntegrityIssues();
    expect(issues).toEqual([]); // 1 円差は許容
  });
});
