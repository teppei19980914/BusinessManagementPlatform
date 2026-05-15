/**
 * tenant-self.service の単体テスト (2026-05-09 / PR E coverage 補強)
 *
 * 検証対象:
 *   - getTenantSelfInfo: 取得 + 派生フィールド (Beginner 期限) 整形
 *   - updateBillingContact: 部分更新 + 個人プラン切替時の null クリア
 *   - updateTenantSelf: プラン変更 (全方向即時反映 / Beginner ダウングレード拒否) +
 *     予算更新 + seedDataEnabled toggle
 *   - cancelScheduledPlanChange: 予約クリア (legacy 予約レコード対策)
 *
 * 2026-05-14: Expert↔Pro ダウングレードを即時反映に統一。「Pro→Expert は翌月予約」
 *   ケースを「Pro→Expert は即時反映」に更新。
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
  updateTenantI18n,
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
  // PR-1 (2026-05-15): テナント単位 i18n
  timezone: 'Asia/Tokyo',
  locale: 'ja-JP',
  // PR-S5 (2026-05-14): Stripe 連携情報 (= 既存 invoice テナントは全 null)
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  stripeSubscriptionStatus: null,
  stripeSubscriptionItemHaikuId: null,
  stripeSubscriptionItemSonnetId: null,
  stripeSubscriptionItemStorageId: null,
  stripeDefaultPaymentMethodId: null,
  cardLastVerifiedAt: null,
  cardVerificationStatus: null,
  autoSuspendScheduledAt: null,
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

  it('PR-S5: Stripe 連携情報を返す (= 既存テナントは全 null)', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(baseTenant as never);
    vi.mocked(prisma.user.count).mockResolvedValueOnce(0);

    const r = await getTenantSelfInfo(TENANT_ID);

    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.stripeCustomerId).toBeNull();
    expect(r.stripeSubscriptionStatus).toBeNull();
    expect(r.stripeDefaultPaymentMethodId).toBeNull();
    expect(r.cardVerificationStatus).toBeNull();
    expect(r.cardLastVerifiedAt).toBeNull();
    expect(r.autoSuspendScheduledAt).toBeNull();
  });

  it('PR-S5: credit_card 払いテナントは Stripe 連携情報をそのまま返す', async () => {
    const cardVerifiedAt = new Date('2026-05-01T00:00:00Z');
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      ...baseTenant,
      paymentMethod: 'credit_card',
      stripeCustomerId: 'cus_test_123',
      stripeSubscriptionStatus: 'active',
      stripeDefaultPaymentMethodId: 'pm_test_456',
      cardVerificationStatus: 'valid',
      cardLastVerifiedAt: cardVerifiedAt,
    } as never);
    vi.mocked(prisma.user.count).mockResolvedValueOnce(0);

    const r = await getTenantSelfInfo(TENANT_ID);

    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.paymentMethod).toBe('credit_card');
    expect(r.stripeCustomerId).toBe('cus_test_123');
    expect(r.stripeSubscriptionStatus).toBe('active');
    expect(r.stripeDefaultPaymentMethodId).toBe('pm_test_456');
    expect(r.cardVerificationStatus).toBe('valid');
    expect(r.cardLastVerifiedAt).toEqual(cardVerifiedAt);
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

  it('PR-2: 現プラン Beginner で budget (非 null) 指定: BEGINNER_BUDGET_NOT_ALLOWED', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce({
      ...baseTenant,
      plan: 'beginner',
      beginnerEverUpgraded: false,
    } as never);

    const r = await updateTenantSelf(TENANT_ID, { monthlyBudgetCapJpy: 5000 });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('BEGINNER_BUDGET_NOT_ALLOWED');
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('PR-2: 現プラン Beginner で budget=null 指定: 通る (残値クリアの救済)', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce({
      ...baseTenant,
      plan: 'beginner',
      beginnerEverUpgraded: false,
      monthlyBudgetCapJpy: 1000,
    } as never);

    const r = await updateTenantSelf(TENANT_ID, { monthlyBudgetCapJpy: null });

    expect(r.ok).toBe(true);
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { monthlyBudgetCapJpy: null },
    });
  });

  it('PR-2: Expert で budget 指定: 従来通り通る', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce({
      ...baseTenant,
      plan: 'expert',
    } as never);

    const r = await updateTenantSelf(TENANT_ID, { monthlyBudgetCapJpy: 3000 });

    expect(r.ok).toBe(true);
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { monthlyBudgetCapJpy: 3000 },
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

  it('Pro → Expert ダウングレード: 即時反映 (2026-05-14 改修)', async () => {
    // 旧仕様では翌月 1 日 (テナント TZ 0:00) に予約されていたが、
    // 業務仕様書 §F-13.11 (「Expert ↔ Pro の切替は即時反映」) と整合させるため即時化。
    // per-call 課金は呼出時点の単価で記録されるため、月途中切替でも整合性は保たれる。
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce({ ...baseTenant, plan: 'pro' } as never);

    const r = await updateTenantSelf(TENANT_ID, { plan: 'expert' });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.appliedImmediately).toBe(true);
      expect(r.scheduledFor).toBeNull();
    }
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: expect.objectContaining({
        plan: 'expert',
        scheduledPlanChangeAt: null,
        scheduledNextPlan: null,
        // beginnerEverUpgraded はアップグレード/ダウングレード問わず true セット (Beginner 戻し防止)
        beginnerEverUpgraded: true,
      }),
    });
  });

  it('Expert → Beginner ダウングレード: BEGINNER_DOWNGRADE_FORBIDDEN', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce(baseTenant as never);

    const r = await updateTenantSelf(TENANT_ID, { plan: 'beginner' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('BEGINNER_DOWNGRADE_FORBIDDEN');
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('ダウングレード (Pro→Expert 即時) と同時に budget も指定できる', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce({ ...baseTenant, plan: 'pro' } as never);

    await updateTenantSelf(TENANT_ID, { plan: 'expert', monthlyBudgetCapJpy: 2000 });

    const data = vi.mocked(prisma.tenant.update).mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.monthlyBudgetCapJpy).toBe(2000);
    // 2026-05-14: 即時反映なので plan が直接更新され、予約フィールドは null クリア
    expect(data.plan).toBe('expert');
    expect(data.scheduledNextPlan).toBeNull();
    expect(data.scheduledPlanChangeAt).toBeNull();
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

describe('updateTenantI18n (PR-1 / 2026-05-15)', () => {
  it('timezone のみ指定: timezone のみ update する', async () => {
    vi.mocked(prisma.tenant.update).mockResolvedValueOnce({
      timezone: 'America/New_York',
      locale: 'ja-JP',
    } as never);

    const r = await updateTenantI18n(TENANT_ID, { timezone: 'America/New_York' });

    expect(r).toEqual({ timezone: 'America/New_York', locale: 'ja-JP' });
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { timezone: 'America/New_York' },
      select: { timezone: true, locale: true },
    });
  });

  it('locale のみ指定: locale のみ update する', async () => {
    vi.mocked(prisma.tenant.update).mockResolvedValueOnce({
      timezone: 'Asia/Tokyo',
      locale: 'en-US',
    } as never);

    const r = await updateTenantI18n(TENANT_ID, { locale: 'en-US' });

    expect(r).toEqual({ timezone: 'Asia/Tokyo', locale: 'en-US' });
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { locale: 'en-US' },
      select: { timezone: true, locale: true },
    });
  });

  it('両方指定: 両方 update する', async () => {
    vi.mocked(prisma.tenant.update).mockResolvedValueOnce({
      timezone: 'UTC',
      locale: 'en-US',
    } as never);
    const r = await updateTenantI18n(TENANT_ID, { timezone: 'UTC', locale: 'en-US' });
    expect(r).toEqual({ timezone: 'UTC', locale: 'en-US' });
  });

  it('空入力: update を呼ばず現在値を返す (no-op)', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce({
      timezone: 'Asia/Tokyo',
      locale: 'ja-JP',
    } as never);

    const r = await updateTenantI18n(TENANT_ID, {});

    expect(r).toEqual({ timezone: 'Asia/Tokyo', locale: 'ja-JP' });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('空文字列の timezone は無視する (no-op 扱い)', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce({
      timezone: 'Asia/Tokyo',
      locale: 'ja-JP',
    } as never);
    const r = await updateTenantI18n(TENANT_ID, { timezone: '', locale: '' });
    expect(r).toEqual({ timezone: 'Asia/Tokyo', locale: 'ja-JP' });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });
});

// ================================================================
// 2026-05-11: 期限切れ Beginner → アップグレード → 復帰 統合シナリオ
// ================================================================

describe('expired Beginner upgrade scenario (2026-05-11)', () => {
  /**
   * シナリオ:
   *   1. 期限切れ Beginner (Day 95) のテナントが getTenantSelfInfo で 'expired' 判定される
   *   2. updateTenantSelf で plan=expert を呼ぶ
   *   3. 即時アップグレード成功 + beginnerEverUpgraded=true がセットされる
   *   4. 以降は middleware の read-only 判定でも対象外になる
   *      (= isBeginnerExpired は beginnerEverUpgraded=true で常に false を返す)
   *
   * これにより、PR #341 で middleware の bypass + 自動削除を加えた仕様の
   * 「ユーザが Day 90 以降でも自分でアップグレードで復帰できる」を保証する。
   */
  const expiredBeginnerTenant = {
    ...baseTenant,
    plan: 'beginner',
    beginnerEverUpgraded: false,
    // 95 日前 (= expired 状態) を固定値で再現
    createdAt: new Date(Date.now() - 95 * 24 * 60 * 60 * 1000),
  };

  it('Step 1: 期限切れ Beginner は getTenantSelfInfo で beginnerExpiryState=expired を返す', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(expiredBeginnerTenant as never);
    vi.mocked(prisma.user.count).mockResolvedValueOnce(2);

    const r = await getTenantSelfInfo(TENANT_ID);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.plan).toBe('beginner');
    expect(r.beginnerExpiryState).toBe('expired');
    expect(r.beginnerDaysRemaining).toBeLessThanOrEqual(-5); // Day 90+ なので残り日数は負
  });

  it('Step 2 + 3: 期限切れ Beginner → Expert アップグレードは即時反映 + beginnerEverUpgraded=true', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce(expiredBeginnerTenant as never);

    const r = await updateTenantSelf(TENANT_ID, { plan: 'expert' });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.appliedImmediately).toBe(true);

    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: expect.objectContaining({
        plan: 'expert',
        beginnerEverUpgraded: true,
        scheduledPlanChangeAt: null,
        scheduledNextPlan: null,
      }),
    });
  });

  it('Step 4: アップグレード後の getTenantSelfInfo は beginnerExpiryState=active を返す', async () => {
    // アップグレード後の state を模した tenant 状態
    const upgradedTenant = {
      ...expiredBeginnerTenant,
      plan: 'expert',
      beginnerEverUpgraded: true,
    };
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(upgradedTenant as never);
    vi.mocked(prisma.user.count).mockResolvedValueOnce(2);

    const r = await getTenantSelfInfo(TENANT_ID);
    expect(r).not.toBeNull();
    if (!r) return;
    // plan != 'beginner' & beginnerEverUpgraded=true なので 'active' (制御対象外)
    expect(r.beginnerExpiryState).toBe('active');
    expect(r.beginnerDaysRemaining).toBeNull();
  });
});
