/**
 * billing-management.service の単体テスト (PR-V7a / 2026-05-19)
 *
 * 検証観点:
 *   1. confirmInvoicePayment: 正常系 (invoice + pending → paid)
 *   2. credit_card は拒否 (= Webhook 自動化されたフローを侵さない)
 *   3. pending 以外 (paid / failed / refunded) は拒否
 *   4. 存在しない id は NOT_FOUND
 *   5. AuditLog に before/after 値と operation='manual_payment_confirmation' が記録される
 *   6. paidAt のデフォルトは now(), override も反映される
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    billingHistory: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '@/lib/db';
import { confirmInvoicePayment } from './billing-management.service';

const SUPER_ADMIN_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BILLING_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TENANT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

beforeEach(() => {
  vi.clearAllMocks();
  // $transaction を「callback を即時実行」にスタブ
  vi.mocked(prisma.$transaction).mockImplementation(async (cb: unknown) => {
    if (typeof cb === 'function') {
      return (cb as (tx: typeof prisma) => Promise<unknown>)(prisma);
    }
    return null;
  });
});

describe('confirmInvoicePayment', () => {
  it('invoice + pending → paid 遷移 + AuditLog 記録', async () => {
    vi.mocked(prisma.billingHistory.findUnique).mockResolvedValue({
      id: BILLING_ID,
      tenantId: TENANT_ID,
      paymentMethod: 'invoice',
      status: 'pending',
      paidAt: null,
    } as never);

    const result = await confirmInvoicePayment(BILLING_ID, SUPER_ADMIN_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.id).toBe(BILLING_ID);
      expect(result.paidAt).toBeInstanceOf(Date);
    }
    expect(prisma.billingHistory.update).toHaveBeenCalledWith({
      where: { id: BILLING_ID },
      data: expect.objectContaining({
        status: 'paid',
        confirmedBy: SUPER_ADMIN_ID,
      }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        userId: SUPER_ADMIN_ID,
        action: 'UPDATE',
        entityType: 'BillingHistory',
        entityId: BILLING_ID,
        afterValue: expect.objectContaining({
          status: 'paid',
          operation: 'manual_payment_confirmation',
        }),
      }),
    });
  });

  it('credit_card は拒否される (Stripe Webhook で自動消込される設計)', async () => {
    vi.mocked(prisma.billingHistory.findUnique).mockResolvedValue({
      id: BILLING_ID,
      tenantId: TENANT_ID,
      paymentMethod: 'credit_card',
      status: 'pending',
      paidAt: null,
    } as never);

    const result = await confirmInvoicePayment(BILLING_ID, SUPER_ADMIN_ID);

    expect(result).toEqual({ ok: false, error: 'INVALID_PAYMENT_METHOD' });
    expect(prisma.billingHistory.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('既に paid なレコードは拒否', async () => {
    vi.mocked(prisma.billingHistory.findUnique).mockResolvedValue({
      id: BILLING_ID,
      tenantId: TENANT_ID,
      paymentMethod: 'invoice',
      status: 'paid',
      paidAt: new Date('2026-05-15'),
    } as never);

    const result = await confirmInvoicePayment(BILLING_ID, SUPER_ADMIN_ID);

    expect(result).toEqual({ ok: false, error: 'INVALID_STATUS' });
    expect(prisma.billingHistory.update).not.toHaveBeenCalled();
  });

  it('refunded / canceled / replaced_by_stripe も拒否', async () => {
    for (const status of ['refunded', 'canceled', 'replaced_by_stripe', 'failed']) {
      vi.mocked(prisma.billingHistory.findUnique).mockResolvedValue({
        id: BILLING_ID,
        tenantId: TENANT_ID,
        paymentMethod: 'invoice',
        status,
        paidAt: null,
      } as never);

      const result = await confirmInvoicePayment(BILLING_ID, SUPER_ADMIN_ID);
      expect(result).toEqual({ ok: false, error: 'INVALID_STATUS' });
    }
  });

  it('存在しない id は NOT_FOUND', async () => {
    vi.mocked(prisma.billingHistory.findUnique).mockResolvedValue(null);

    const result = await confirmInvoicePayment('non-existent', SUPER_ADMIN_ID);

    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('paidAt override が反映される (= 振込日を遡って指定するケース)', async () => {
    vi.mocked(prisma.billingHistory.findUnique).mockResolvedValue({
      id: BILLING_ID,
      tenantId: TENANT_ID,
      paymentMethod: 'invoice',
      status: 'pending',
      paidAt: null,
    } as never);

    const backdated = new Date('2026-05-10T00:00:00Z');
    const result = await confirmInvoicePayment(BILLING_ID, SUPER_ADMIN_ID, backdated);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.paidAt).toEqual(backdated);
    }
    expect(prisma.billingHistory.update).toHaveBeenCalledWith({
      where: { id: BILLING_ID },
      data: expect.objectContaining({
        paidAt: backdated,
      }),
    });
  });
});
