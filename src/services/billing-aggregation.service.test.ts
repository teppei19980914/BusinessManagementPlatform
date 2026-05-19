/**
 * billing-aggregation.service の単体テスト (PR-V7a / 2026-05-19)
 *
 * 検証項目:
 *   1. 通常系: API 利用 + Storage add-on の subtotal → 税込 total が正しい
 *   2. 既存 status='pending' は金額更新される
 *   3. 既存 status='paid' / 'replaced_by_stripe' は触らない (skipped)
 *   4. 解約済 + ¥0 利用テナントは INSERT しない
 *   5. 解約済 + 利用ありテナントは INSERT する
 *   6. credit_card テナントは対象外 (= where 句で除外)
 *   7. MANAGEMENT テナントは対象外
 *   8. 不正な yearMonth で throw
 *   9. 一部テナントで例外発生時、他のテナント処理は継続 (errors に蓄積)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: { findMany: vi.fn() },
    apiCallLog: { aggregate: vi.fn() },
    billingHistory: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock('@/lib/tenant', () => ({
  MANAGEMENT_TENANT_ID: '00000000-0000-0000-0000-ffffffffffff',
}));

// PR-V7a 再検証 round 2: 部分失敗 alert の verify
const mockSendSuperAdminAlert = vi.fn();
vi.mock('./admin-alert.service', () => ({
  sendSuperAdminAlert: (...args: unknown[]) => mockSendSuperAdminAlert(...args),
}));

import { prisma } from '@/lib/db';
import { aggregateInvoiceBillingForMonth } from './billing-aggregation.service';

beforeEach(() => {
  vi.clearAllMocks();
  mockSendSuperAdminAlert.mockReset();
  mockSendSuperAdminAlert.mockResolvedValue({ sentTo: ['admin@example.com'], failures: [] });
});

const TENANT_A = { id: 'tenant-a', timezone: 'Asia/Tokyo', storageAddonPlan: 'standard', deletedAt: null };
const TENANT_B = { id: 'tenant-b', timezone: 'Asia/Tokyo', storageAddonPlan: 'plus', deletedAt: null };
const TENANT_DELETED = { id: 'tenant-del', timezone: 'Asia/Tokyo', storageAddonPlan: 'standard', deletedAt: new Date() };

describe('aggregateInvoiceBillingForMonth', () => {
  it('API ¥1,000 + Storage ¥0 (standard) → subtotal=¥1000 / tax=¥100 / total=¥1100 で upsert', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([TENANT_A] as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _sum: { costJpy: 1000 },
    } as never);
    vi.mocked(prisma.billingHistory.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.billingHistory.upsert).mockResolvedValue({} as never);

    const result = await aggregateInvoiceBillingForMonth('2026-05');

    expect(result.processedTenants).toBe(1);
    expect(result.upsertedRecords).toBe(1);
    expect(result.totalSubtotalJpy).toBe(1000);
    expect(result.totalTaxJpy).toBe(100);
    expect(result.totalGrandJpy).toBe(1100);

    const upsertCall = vi.mocked(prisma.billingHistory.upsert).mock.calls[0]?.[0] as {
      create: { amountJpy: number; taxAmountJpy: number; totalAmountJpy: number; status: string; paymentMethod: string };
    };
    expect(upsertCall.create.amountJpy).toBe(1000);
    expect(upsertCall.create.taxAmountJpy).toBe(100);
    expect(upsertCall.create.totalAmountJpy).toBe(1100);
    expect(upsertCall.create.status).toBe('pending');
    expect(upsertCall.create.paymentMethod).toBe('invoice');
  });

  it('Storage plus +¥500 が合算される', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([TENANT_B] as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _sum: { costJpy: 0 },
    } as never);
    vi.mocked(prisma.billingHistory.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.billingHistory.upsert).mockResolvedValue({} as never);

    const result = await aggregateInvoiceBillingForMonth('2026-05');

    expect(result.totalSubtotalJpy).toBe(500); // = Storage Plus 月額
    expect(result.totalTaxJpy).toBe(50);
    expect(result.totalGrandJpy).toBe(550);
  });

  it('既存 status=paid は触らない (skipped)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([TENANT_A] as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _sum: { costJpy: 1000 },
    } as never);
    vi.mocked(prisma.billingHistory.findUnique).mockResolvedValue({ status: 'paid' } as never);

    const result = await aggregateInvoiceBillingForMonth('2026-05');

    expect(result.skippedTenants).toBe(1);
    expect(result.upsertedRecords).toBe(0);
    expect(prisma.billingHistory.upsert).not.toHaveBeenCalled();
  });

  it('既存 status=replaced_by_stripe / refunded / canceled / failed も触らない', async () => {
    for (const status of ['replaced_by_stripe', 'refunded', 'canceled', 'failed']) {
      vi.clearAllMocks();
      vi.mocked(prisma.tenant.findMany).mockResolvedValue([TENANT_A] as never);
      vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
        _sum: { costJpy: 1000 },
      } as never);
      vi.mocked(prisma.billingHistory.findUnique).mockResolvedValue({ status } as never);

      const result = await aggregateInvoiceBillingForMonth('2026-05');
      expect(result.skippedTenants).toBe(1);
      expect(prisma.billingHistory.upsert).not.toHaveBeenCalled();
    }
  });

  it('既存 status=pending は金額が更新される', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([TENANT_A] as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _sum: { costJpy: 1500 },
    } as never);
    vi.mocked(prisma.billingHistory.findUnique).mockResolvedValue({ status: 'pending' } as never);
    vi.mocked(prisma.billingHistory.upsert).mockResolvedValue({} as never);

    const result = await aggregateInvoiceBillingForMonth('2026-05');

    expect(result.upsertedRecords).toBe(1);
    const upsertCall = vi.mocked(prisma.billingHistory.upsert).mock.calls[0]?.[0] as {
      update: { amountJpy: number };
    };
    expect(upsertCall.update.amountJpy).toBe(1500);
  });

  it('解約済 + ¥0 利用 → INSERT しない (= 空請求書を作らない)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([TENANT_DELETED] as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _sum: { costJpy: 0 },
    } as never);

    const result = await aggregateInvoiceBillingForMonth('2026-05');

    expect(result.skippedTenants).toBe(1);
    expect(result.upsertedRecords).toBe(0);
    expect(prisma.billingHistory.upsert).not.toHaveBeenCalled();
  });

  it('解約済 + 利用ありなら INSERT する (= 締日前の利用分は請求対象)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([TENANT_DELETED] as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _sum: { costJpy: 2000 },
    } as never);
    vi.mocked(prisma.billingHistory.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.billingHistory.upsert).mockResolvedValue({} as never);

    const result = await aggregateInvoiceBillingForMonth('2026-05');

    expect(result.upsertedRecords).toBe(1);
    expect(result.totalSubtotalJpy).toBe(2000);
  });

  it('テナント findMany の where 句で credit_card 除外 + MANAGEMENT 除外を強制', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([] as never);

    await aggregateInvoiceBillingForMonth('2026-05');

    const where = vi.mocked(prisma.tenant.findMany).mock.calls[0]?.[0]?.where as {
      paymentMethod: { in: string[] };
      id: { not: string };
    };
    expect(where.paymentMethod.in).toEqual(['invoice', 'bank_transfer']);
    expect(where.id.not).toBe('00000000-0000-0000-0000-ffffffffffff');
  });

  it('不正な yearMonth で throw', async () => {
    await expect(aggregateInvoiceBillingForMonth('2026/05')).rejects.toThrow();
    await expect(aggregateInvoiceBillingForMonth('invalid')).rejects.toThrow();
  });

  it('一部テナントの例外で他は継続 (errors に蓄積)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([TENANT_A, TENANT_B] as never);
    vi.mocked(prisma.apiCallLog.aggregate)
      .mockRejectedValueOnce(new Error('db error A'))
      .mockResolvedValueOnce({ _sum: { costJpy: 500 } } as never);
    vi.mocked(prisma.billingHistory.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.billingHistory.upsert).mockResolvedValue({} as never);

    const result = await aggregateInvoiceBillingForMonth('2026-05');

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.tenantId).toBe('tenant-a');
    expect(result.processedTenants).toBe(1); // tenant-b のみ成功
    expect(result.upsertedRecords).toBe(1);
  });

  // PR-V7a 再検証 round 2: per-tenant 失敗の active push (= 真の改善)
  it('[再検証 round 2] errors > 0 で sendSuperAdminAlert を呼出', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([TENANT_A, TENANT_B] as never);
    vi.mocked(prisma.apiCallLog.aggregate)
      .mockRejectedValueOnce(new Error('db error A'))
      .mockResolvedValueOnce({ _sum: { costJpy: 500 } } as never);
    vi.mocked(prisma.billingHistory.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.billingHistory.upsert).mockResolvedValue({} as never);

    await aggregateInvoiceBillingForMonth('2026-05');

    expect(mockSendSuperAdminAlert).toHaveBeenCalledTimes(1);
    const [subject, body] = mockSendSuperAdminAlert.mock.calls[0]!;
    expect(subject).toContain('invoice 月次集計で 1 件のエラー');
    expect(subject).toContain('2026-05');
    expect(body).toContain('tenant tenant-a');
    expect(body).toContain('db error A');
    expect(body).toContain('?yearMonth=2026-05'); // 手動再実行手順
  });

  it('[再検証 round 2] errors = 0 なら alert なし', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([TENANT_A] as never);
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValue({
      _sum: { costJpy: 1000 },
    } as never);
    vi.mocked(prisma.billingHistory.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.billingHistory.upsert).mockResolvedValue({} as never);

    await aggregateInvoiceBillingForMonth('2026-05');

    expect(mockSendSuperAdminAlert).not.toHaveBeenCalled();
  });
});
