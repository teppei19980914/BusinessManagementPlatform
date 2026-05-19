/**
 * admin-alert.service の単体テスト (PR-V7a / 2026-05-19)
 *
 * 検証項目:
 *   1. sendSuperAdminAlert: super_admin 全員にメール、failure 行は failures[] に
 *   2. sendSuperAdminAlert: super_admin 0 人なら SUPER_ADMIN_INITIAL_EMAIL にフォールバック
 *   3. detectAndAlertOverdueInvoices: 期日超過 + 24h dedup
 *   4. detectAndAlertOverdueInvoices: 該当なしならメール送信なし
 *   5. detectAndAlertCronFailures: cron 名別集約 + メール送信
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findMany: vi.fn() },
    billingHistory: { findMany: vi.fn(), updateMany: vi.fn() },
    cronExecutionLog: { findMany: vi.fn() },
  },
}));

const mockSend = vi.fn();
vi.mock('@/lib/mail', () => ({
  getMailProvider: () => ({ send: mockSend }),
}));

vi.mock('@/lib/tenant', () => ({
  MANAGEMENT_TENANT_ID: '00000000-0000-0000-0000-ffffffffffff',
}));

import { prisma } from '@/lib/db';
import {
  sendSuperAdminAlert,
  detectAndAlertOverdueInvoices,
  detectAndAlertCronFailures,
} from './admin-alert.service';

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  delete process.env['SUPER_ADMIN_INITIAL_EMAIL'];
});

afterEach(() => {
  delete process.env['SUPER_ADMIN_INITIAL_EMAIL'];
});

describe('sendSuperAdminAlert', () => {
  it('super_admin 全員にメール送信', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { email: 'a@example.com' },
      { email: 'b@example.com' },
    ] as never);
    mockSend.mockResolvedValue({ success: true });

    const result = await sendSuperAdminAlert('subj', 'body');

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(result.sentTo).toEqual(['a@example.com', 'b@example.com']);
    expect(result.failures).toEqual([]);
  });

  it('super_admin 0 人なら SUPER_ADMIN_INITIAL_EMAIL にフォールバック', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);
    process.env['SUPER_ADMIN_INITIAL_EMAIL'] = 'fallback@example.com';
    mockSend.mockResolvedValue({ success: true });

    const result = await sendSuperAdminAlert('s', 'b');

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'fallback@example.com' }),
    );
    expect(result.sentTo).toEqual(['fallback@example.com']);
  });

  it('送信失敗は failures[] に蓄積', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { email: 'ok@example.com' },
      { email: 'fail@example.com' },
    ] as never);
    mockSend
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'invalid' });

    const result = await sendSuperAdminAlert('s', 'b');

    expect(result.sentTo).toEqual(['ok@example.com']);
    expect(result.failures).toEqual(['fail@example.com']);
  });
});

describe('detectAndAlertOverdueInvoices', () => {
  it('期日超過があれば alert メール送信 + overdueAlertSentAt 更新', async () => {
    const now = new Date('2026-07-05T00:00:00Z');
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValue([
      {
        id: 'b1',
        tenantId: 't1',
        yearMonth: '2026-05',
        totalAmountJpy: 1100,
        // 期日 2026-06-25 + 5 日 = 2026-06-30 超過確実
        paymentDueDate: new Date('2026-06-25T14:59:59.999Z'),
        tenant: { name: 'Tenant A' },
      },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { email: 'admin@example.com' },
    ] as never);
    vi.mocked(prisma.billingHistory.updateMany).mockResolvedValue({ count: 1 } as never);
    mockSend.mockResolvedValue({ success: true });

    const result = await detectAndAlertOverdueInvoices(now);

    expect(result.detectedCount).toBe(1);
    expect(result.alertSent).toBe(true);
    expect(result.recipientsCount).toBe(1);
    expect(prisma.billingHistory.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['b1'] } },
      data: { overdueAlertSentAt: now },
    });
  });

  it('期日内 (= 閾値以内) はカウントしない', async () => {
    const now = new Date('2026-06-28T00:00:00Z');
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValue([
      {
        id: 'b1',
        tenantId: 't1',
        yearMonth: '2026-05',
        totalAmountJpy: 1100,
        // 期日 2026-06-25 + 5 日 = 6/30 まで猶予 → 6/28 はまだ猶予内
        paymentDueDate: new Date('2026-06-25T14:59:59.999Z'),
        tenant: { name: 'Tenant A' },
      },
    ] as never);

    const result = await detectAndAlertOverdueInvoices(now);

    expect(result.detectedCount).toBe(0);
    expect(result.alertSent).toBe(false);
    expect(result.skippedDueToRecentAlert).toBe(1);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('candidates 0 件なら alert 送信なし', async () => {
    vi.mocked(prisma.billingHistory.findMany).mockResolvedValue([] as never);

    const result = await detectAndAlertOverdueInvoices(new Date());

    expect(result.detectedCount).toBe(0);
    expect(result.alertSent).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
    expect(prisma.billingHistory.updateMany).not.toHaveBeenCalled();
  });
});

describe('detectAndAlertCronFailures', () => {
  it('失敗 cron があれば集約メール送信', async () => {
    vi.mocked(prisma.cronExecutionLog.findMany).mockResolvedValue([
      {
        cronName: 'stripe-reconcile',
        startedAt: new Date('2026-05-19T01:00:00Z'),
        errorMessage: 'timeout',
      },
      {
        cronName: 'stripe-reconcile',
        startedAt: new Date('2026-05-19T02:00:00Z'),
        errorMessage: 'timeout',
      },
      {
        cronName: 'stripe-usage-flush',
        startedAt: new Date('2026-05-19T03:00:00Z'),
        errorMessage: 'rate_limit',
      },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { email: 'admin@example.com' },
    ] as never);
    mockSend.mockResolvedValue({ success: true });

    const result = await detectAndAlertCronFailures(new Date('2026-05-19T10:00:00Z'));

    expect(result.failedCount).toBe(3);
    expect(result.alertSent).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const sendArgs = mockSend.mock.calls[0]?.[0];
    expect(sendArgs.subject).toContain('cron 実行失敗 3 件');
    expect(sendArgs.text).toContain('stripe-reconcile: 2 回失敗');
    expect(sendArgs.text).toContain('stripe-usage-flush: 1 回失敗');
  });

  it('失敗 0 件ならメール送信なし', async () => {
    vi.mocked(prisma.cronExecutionLog.findMany).mockResolvedValue([] as never);

    const result = await detectAndAlertCronFailures(new Date());

    expect(result.failedCount).toBe(0);
    expect(result.alertSent).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
