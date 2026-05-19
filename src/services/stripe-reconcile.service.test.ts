/**
 * stripe-reconcile.service の単体テスト (PR-V7 #5 / 2026-05-19)
 *
 * 検証観点:
 *   1. STRIPE_ENABLED=false → 即 return + skippedStripeDisabled=true
 *   2. 候補ゼロ件 → matched=0 で返却
 *   3. DB ↔ Stripe 一致 → matched++
 *   4. DB ↔ Stripe 乖離 → corrected++ + tenant.update + auditLog
 *   5. Stripe 側で Subscription 削除済 (= No such subscription) → lostAndCanceled
 *   6. Stripe API その他エラー → errors[]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    billingHistory: {
      findMany: vi.fn(),
    },
  },
}));

let stripeEnabled = true;
const mockRetrieve = vi.fn();
const mockInvoiceRetrieve = vi.fn();
vi.mock('@/lib/stripe', () => ({
  isStripeEnabled: () => stripeEnabled,
  getStripe: () => ({
    subscriptions: { retrieve: (...args: unknown[]) => mockRetrieve(...args) },
    invoices: { retrieve: (...args: unknown[]) => mockInvoiceRetrieve(...args) },
  }),
}));

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));

// PR-V7a 穴 D/E 修正: alert を mock
vi.mock('./admin-alert.service', () => ({
  sendSuperAdminAlert: vi.fn().mockResolvedValue({
    sentTo: ['admin@example.com'],
    failures: [],
  }),
}));

import { prisma } from '@/lib/db';
import { recordError } from '@/services/error-log.service';
import { sendSuperAdminAlert } from './admin-alert.service';
import {
  reconcileStripeSubscriptions,
  reconcileBillingHistoryAmounts,
} from './stripe-reconcile.service';

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

beforeEach(() => {
  vi.clearAllMocks();
  stripeEnabled = true;
});

describe('reconcileStripeSubscriptions', () => {
  it('STRIPE_ENABLED=false → 即 return + skippedStripeDisabled=true', async () => {
    stripeEnabled = false;
    const result = await reconcileStripeSubscriptions();
    expect(result.skippedStripeDisabled).toBe(true);
    expect(result.candidates).toBe(0);
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
  });

  it('候補ゼロ件で 0 件返却', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([] as never);
    const result = await reconcileStripeSubscriptions();
    expect(result).toEqual({
      candidates: 0,
      matched: 0,
      corrected: 0,
      lostAndCanceled: 0,
      errors: [],
    });
  });

  it('DB ↔ Stripe 一致 → matched++ で DB 更新なし', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      {
        id: TENANT_A,
        stripeSubscriptionId: 'sub_xxx',
        stripeSubscriptionStatus: 'active',
      },
    ] as never);
    mockRetrieve.mockResolvedValueOnce({
      id: 'sub_xxx',
      status: 'active',
    });

    const result = await reconcileStripeSubscriptions();

    expect(result.matched).toBe(1);
    expect(result.corrected).toBe(0);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('DB=active / Stripe=past_due 乖離 → corrected + DB を past_due に補正 + auditLog', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      {
        id: TENANT_A,
        stripeSubscriptionId: 'sub_xxx',
        stripeSubscriptionStatus: 'active',
      },
    ] as never);
    mockRetrieve.mockResolvedValueOnce({
      id: 'sub_xxx',
      status: 'past_due',
    });

    const result = await reconcileStripeSubscriptions();

    expect(result.corrected).toBe(1);
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_A },
      data: { stripeSubscriptionStatus: 'past_due' },
    });
    const audit = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0];
    expect(audit?.data.afterValue).toMatchObject({
      stripeSubscriptionStatus: 'past_due',
      reason: 'stripe_reconcile_corrected_drift',
    });
  });

  it('Stripe 側で Subscription 削除済 (= No such subscription) → lostAndCanceled', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      {
        id: TENANT_A,
        stripeSubscriptionId: 'sub_deleted',
        stripeSubscriptionStatus: 'active',
      },
    ] as never);
    const StripeImport = await import('stripe');
    mockRetrieve.mockRejectedValueOnce(
      new StripeImport.default.errors.StripeInvalidRequestError({
        message: 'No such subscription: sub_deleted',
        type: 'invalid_request_error',
      }),
    );

    const result = await reconcileStripeSubscriptions();

    expect(result.lostAndCanceled).toBe(1);
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_A },
      data: { stripeSubscriptionStatus: 'canceled' },
    });
  });

  it('Stripe 側で既に canceled に整合済 (= No such subscription かつ DB も canceled) → matched', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      {
        id: TENANT_A,
        stripeSubscriptionId: 'sub_deleted',
        stripeSubscriptionStatus: 'canceled',
      },
    ] as never);
    const StripeImport = await import('stripe');
    mockRetrieve.mockRejectedValueOnce(
      new StripeImport.default.errors.StripeInvalidRequestError({
        message: 'No such subscription: sub_deleted',
        type: 'invalid_request_error',
      }),
    );

    const result = await reconcileStripeSubscriptions();

    expect(result.matched).toBe(1);
    expect(result.lostAndCanceled).toBe(0);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('Stripe API その他エラー → errors[] + recordError + cron 全体は止まらない', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      {
        id: TENANT_A,
        stripeSubscriptionId: 'sub_xxx',
        stripeSubscriptionStatus: 'active',
      },
      {
        id: TENANT_B,
        stripeSubscriptionId: 'sub_yyy',
        stripeSubscriptionStatus: 'active',
      },
    ] as never);
    const StripeImport = await import('stripe');
    mockRetrieve
      .mockRejectedValueOnce(
        new StripeImport.default.errors.StripeConnectionError({
          message: 'Connection refused',
          // StripeConnectionError は RawErrorType に含まれない値を内部 type に持つため as never で型回避
          type: 'api_connection_error' as never,
        }),
      )
      .mockResolvedValueOnce({ id: 'sub_yyy', status: 'active' });

    const result = await reconcileStripeSubscriptions();

    expect(result.candidates).toBe(2);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.tenantId).toBe(TENANT_A);
    expect(result.matched).toBe(1); // tenant B は成功
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ tenantId: TENANT_A }) }),
    );
  });
});

// ============================================================
// PR-V7a B-2: 金額照合の test
// ============================================================
describe('reconcileBillingHistoryAmounts (PR-V7a B-2)', () => {
  it('STRIPE_ENABLED=false → 即 return + skippedStripeDisabled', async () => {
    stripeEnabled = false;
    const result = await reconcileBillingHistoryAmounts(3);
    expect(result.skippedStripeDisabled).toBe(true);
    expect(result.candidates).toBe(0);
  });

  it('Stripe Invoice と DB が一致 → matched', async () => {
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValue([
      {
        id: 'b1',
        tenantId: TENANT_A,
        stripeInvoiceId: 'in_1',
        amountJpy: 1000,
        taxAmountJpy: 100,
        totalAmountJpy: 1100,
        yearMonth: '2026-05',
      },
    ] as never);
    mockInvoiceRetrieve.mockResolvedValueOnce({
      subtotal: 1000,
      tax: 100,
      total: 1100,
    });

    const result = await reconcileBillingHistoryAmounts(3);

    expect(result.candidates).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.drifted).toBe(0);
    expect(recordError).not.toHaveBeenCalled();
  });

  it('金額乖離 → drifted + recordError', async () => {
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValue([
      {
        id: 'b1',
        tenantId: TENANT_A,
        stripeInvoiceId: 'in_1',
        amountJpy: 1000,
        taxAmountJpy: 100,
        totalAmountJpy: 1100,
        yearMonth: '2026-05',
      },
    ] as never);
    // Stripe 側は ¥2000 (= 大幅乖離)
    mockInvoiceRetrieve.mockResolvedValueOnce({
      subtotal: 2000,
      tax: 200,
      total: 2200,
    });

    const result = await reconcileBillingHistoryAmounts(3);

    expect(result.drifted).toBe(1);
    expect(result.matched).toBe(0);
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        context: expect.objectContaining({
          kind: 'amount_reconcile_drift',
          billingHistoryId: 'b1',
        }),
      }),
    );
  });

  it('±1 円以内の乖離は matched (= tolerance)', async () => {
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValue([
      {
        id: 'b1',
        tenantId: TENANT_A,
        stripeInvoiceId: 'in_1',
        amountJpy: 1000,
        taxAmountJpy: 100,
        totalAmountJpy: 1100,
        yearMonth: '2026-05',
      },
    ] as never);
    // 1 円差は許容
    mockInvoiceRetrieve.mockResolvedValueOnce({
      subtotal: 1001,
      tax: 100,
      total: 1101,
    });

    const result = await reconcileBillingHistoryAmounts(3);
    expect(result.matched).toBe(1);
    expect(result.drifted).toBe(0);
    // alert は送信されない
    expect(sendSuperAdminAlert).not.toHaveBeenCalled();
  });

  // PR-V7a 穴 D: drifted > 0 で active push (sendSuperAdminAlert)
  it('[穴 D] drifted > 0 で sendSuperAdminAlert 呼出 (= active push)', async () => {
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValue([
      {
        id: 'b1',
        tenantId: TENANT_A,
        stripeInvoiceId: 'in_1',
        amountJpy: 1000,
        taxAmountJpy: 100,
        totalAmountJpy: 1100,
        yearMonth: '2026-05',
      },
    ] as never);
    mockInvoiceRetrieve.mockResolvedValueOnce({
      subtotal: 5000,
      tax: 500,
      total: 5500,
    });

    await reconcileBillingHistoryAmounts(3);

    expect(sendSuperAdminAlert).toHaveBeenCalledWith(
      expect.stringContaining('金額乖離 1 件'),
      expect.stringContaining('amount_reconcile_drift'),
    );
  });
});

// PR-V7a 穴 E: reconcileStripeSubscriptions の errors.length > 0 → active push
describe('reconcileStripeSubscriptions errors → alert (PR-V7a 穴 E)', () => {
  it('[穴 E] errors.length > 0 で sendSuperAdminAlert 呼出', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      {
        id: TENANT_A,
        stripeSubscriptionId: 'sub_xxx',
        stripeSubscriptionStatus: 'active',
      },
    ] as never);
    // 不明なエラー (= rate limit / API 障害想定)
    mockRetrieve.mockRejectedValueOnce(new Error('rate_limit_exceeded'));

    await reconcileStripeSubscriptions();

    expect(sendSuperAdminAlert).toHaveBeenCalledWith(
      expect.stringContaining('Stripe Subscription 照合で 1 件のエラー'),
      expect.stringContaining(`tenant ${TENANT_A}`),
    );
  });
});
