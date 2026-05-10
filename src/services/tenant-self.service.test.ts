/**
 * tenant-self.service の単体テスト (2026-05-09 / PR E coverage 補強)
 *
 * 検証対象:
 *   - getTenantSelfInfo: 取得 + 派生フィールド (Beginner 期限) 整形
 *   - updateBillingContact: 部分更新 + 個人プラン切替時の null クリア
 *   - updateTenantSelf: プラン変更 (アップグレード即時 / ダウングレード予約) +
 *     席数チェック + Beginner ダウングレード禁止 + 予算更新 + seedDataEnabled toggle
 *   - cancelScheduledPlanChange: 予約クリア
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      update: vi.fn(),
    },
    user: {
      count: vi.fn(),
    },
  },
}));

import {
  getTenantSelfInfo,
  updateBillingContact,
  updateTenantSelf,
  cancelScheduledPlanChange,
} from './tenant-self.service';
import { prisma } from '@/lib/db';

const TENANT_ID = 'tenant-uuid-1';

beforeEach(() => {
  vi.clearAllMocks();
});

const baseTenant = {
  id: TENANT_ID,
  tenantSeq: 1,
  name: 'テストテナント',
  plan: 'expert',
  monthlyBudgetCapJpy: null,
  beginnerMaxSeats: 5,
  beginnerMonthlyCallLimit: 100,
  currentMonthApiCallCount: 10,
  currentMonthApiCostJpy: 100,
  scheduledPlanChangeAt: null,
  scheduledNextPlan: null,
  billingType: 'corporate',
  billingCompanyName: 'テスト会社',
  billingContactName: '担当者',
  billingContactEmail: 'b@example.com',
  billingAddress: null,
  billingPostalCode: '100-0001',
  billingPrefecture: '東京都',
  billingCity: '千代田区',
  billingStreetAddress: '千代田1-1',
  billingBuildingName: null,
  billingPhoneNumber: '03-1234-5678',
  paymentMethod: 'invoice',
  beginnerEverUpgraded: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  seedDataEnabled: true,
};

describe('getTenantSelfInfo', () => {
  it('テナント不在なら null', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null);
    const r = await getTenantSelfInfo(TENANT_ID);
    expect(r).toBeNull();
  });

  it('取得成功時に DTO + 派生フィールド (beginnerExpiryState / DaysRemaining) を返す', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(baseTenant as never);
    vi.mocked(prisma.user.count).mockResolvedValueOnce(3);

    const r = await getTenantSelfInfo(TENANT_ID);

    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.id).toBe(TENANT_ID);
    expect(r.activeUserCount).toBe(3);
    expect(r.plan).toBe('expert');
    expect(r.seedDataEnabled).toBe(true);
    // expert プランは Beginner 期限の対象外なので null
    expect(r.beginnerDaysRemaining).toBeNull();
    expect(r.beginnerExpiryState).toBe('active');
  });
});

describe('updateBillingContact', () => {
  it('未指定キーは update.data に含めない (no-op で returns)', async () => {
    await updateBillingContact(TENANT_ID, {});
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('billingType=individual 切替時は会社名を null に強制クリア (PR C / #5)', async () => {
    await updateBillingContact(TENANT_ID, { billingType: 'individual' });

    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: expect.objectContaining({
        billingType: 'individual',
        billingCompanyName: null,
      }),
    });
  });

  it('構造化住所サブフィールドを部分更新できる (PR C / #8)', async () => {
    await updateBillingContact(TENANT_ID, {
      billingPostalCode: '160-0023',
      billingPrefecture: '東京都',
      billingCity: '新宿区',
    });

    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: {
        billingPostalCode: '160-0023',
        billingPrefecture: '東京都',
        billingCity: '新宿区',
      },
    });
  });

  it('billingPhoneNumber を null で値クリア指定できる', async () => {
    await updateBillingContact(TENANT_ID, { billingPhoneNumber: null });
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { billingPhoneNumber: null },
    });
  });
});

describe('updateTenantSelf', () => {
  it('budget が負数なら INVALID_BUDGET', async () => {
    const r = await updateTenantSelf(TENANT_ID, { monthlyBudgetCapJpy: -1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('INVALID_BUDGET');
    expect(prisma.tenant.findFirstOrThrow).not.toHaveBeenCalled();
  });

  it('plan 未指定 + budget 指定: 即時反映する', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce(baseTenant as never);

    const r = await updateTenantSelf(TENANT_ID, { monthlyBudgetCapJpy: 5000 });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.appliedImmediately).toBe(true);
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { monthlyBudgetCapJpy: 5000 },
    });
  });

  it('plan 未指定 + seedDataEnabled 指定: 即時反映 (PR G / #24)', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce(baseTenant as never);
    const r = await updateTenantSelf(TENANT_ID, { seedDataEnabled: false });
    expect(r.ok).toBe(true);
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { seedDataEnabled: false },
    });
  });

  it('plan 未指定 + 何も変更なし: update を呼ばない', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce(baseTenant as never);
    const r = await updateTenantSelf(TENANT_ID, {});
    expect(r.ok).toBe(true);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('同一プラン + budget 指定: budget のみ更新', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce(baseTenant as never);

    const r = await updateTenantSelf(TENANT_ID, { plan: 'expert', monthlyBudgetCapJpy: 1000 });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.appliedImmediately).toBe(true);
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { monthlyBudgetCapJpy: 1000 },
    });
  });

  it('同一プラン + budget 未指定: update 呼ばず即時 OK', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce(baseTenant as never);
    const r = await updateTenantSelf(TENANT_ID, { plan: 'expert' });
    expect(r.ok).toBe(true);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('Expert → Pro アップグレード: 即時反映 + beginnerEverUpgraded 強制 true', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce(baseTenant as never);

    const r = await updateTenantSelf(TENANT_ID, { plan: 'pro' });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.appliedImmediately).toBe(true);
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: expect.objectContaining({
        plan: 'pro',
        scheduledPlanChangeAt: null,
        scheduledNextPlan: null,
        beginnerEverUpgraded: true,
      }),
    });
  });

  it('Pro → Expert ダウングレード: 翌月 1 日 (UTC) に予約', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce({ ...baseTenant, plan: 'pro' } as never);

    const r = await updateTenantSelf(TENANT_ID, { plan: 'expert' });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.appliedImmediately).toBe(false);
      expect(r.scheduledFor).toBeInstanceOf(Date);
    }
    const callArg = vi.mocked(prisma.tenant.update).mock.calls[0]![0];
    const data = callArg.data as { scheduledNextPlan?: string; scheduledPlanChangeAt?: Date };
    expect(data.scheduledNextPlan).toBe('expert');
    expect(data.scheduledPlanChangeAt).toBeInstanceOf(Date);
  });

  it('Expert → Beginner ダウングレード: BEGINNER_DOWNGRADE_FORBIDDEN', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce(baseTenant as never);

    const r = await updateTenantSelf(TENANT_ID, { plan: 'beginner' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('BEGINNER_DOWNGRADE_FORBIDDEN');
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('ダウングレード予約と同時に budget も指定できる', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce({ ...baseTenant, plan: 'pro' } as never);

    await updateTenantSelf(TENANT_ID, { plan: 'expert', monthlyBudgetCapJpy: 2000 });

    const data = vi.mocked(prisma.tenant.update).mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.monthlyBudgetCapJpy).toBe(2000);
    expect(data.scheduledNextPlan).toBe('expert');
  });

  it('アップグレードと同時に budget も指定できる', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce(baseTenant as never);

    await updateTenantSelf(TENANT_ID, { plan: 'pro', monthlyBudgetCapJpy: 9999 });

    const data = vi.mocked(prisma.tenant.update).mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.monthlyBudgetCapJpy).toBe(9999);
    expect(data.plan).toBe('pro');
  });
});

describe('cancelScheduledPlanChange', () => {
  it('予約フィールドを null クリア', async () => {
    await cancelScheduledPlanChange(TENANT_ID);
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { scheduledPlanChangeAt: null, scheduledNextPlan: null },
    });
  });
});
