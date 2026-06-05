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
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    user: {
      count: vi.fn(),
    },
    // PR-V7 #3 (2026-05-19): credit_card → invoice 戻し時の Stripe 失敗 auditLog
    auditLog: {
      create: vi.fn(),
    },
  },
}));

// PR-S3 (2026-05-14) / PR-V7 #3 (2026-05-19): Stripe lib + billing service モック
vi.mock('@/lib/stripe', () => ({
  isStripeEnabled: vi.fn(() => false),
}));

const mockVerifyTenantCard = vi.fn();
const mockCancelTenantStripeSubscription = vi.fn();
vi.mock('./stripe-billing.service', () => ({
  verifyTenantCard: (tenantId: string) => mockVerifyTenantCard(tenantId),
  cancelTenantStripeSubscription: (tenantId: string) =>
    mockCancelTenantStripeSubscription(tenantId),
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
  // feat/settings-tenant-identity (2026-05-21): slug + 価格定数 + 停止状態を DTO に追加
  // ADR-0019 (2026-05-24): pricePerCallHaiku 5 → 10
  slug: 'test-tenant',
  pricePerCallHaiku: 10,
  pricePerCallSonnet: 15,
  suspendedAt: null,
  suspendReason: null,
  tenantSeq: 1,
  name: 'テストテナント',
  plan: 'expert',
  monthlyBudgetCapJpy: null,
  beginnerMaxSeats: 5,
  beginnerMonthlyCallLimit: 50, // ADR-0019: 100 → 50
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
  // PR-1 (2026-05-15): テナント単位 i18n
  timezone: 'Asia/Tokyo',
  locale: 'ja-JP',
  // PR-S5 (2026-05-14): Stripe 連携情報 (= 既存 invoice テナントは全 null)
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  stripeSubscriptionStatus: null,
  stripeSubscriptionItemHaikuId: null,
  stripeSubscriptionItemSonnetId: null,
  // chore/storage-addon-backend-removal (2026-05-26): stripeSubscriptionItemStorageId 撤去済
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
    // 2026-06-03: 1 回目 = activeUserCount (有効のみ), 2 回目 = seatUsageCount (有効+招待中)
    vi.mocked(prisma.user.count).mockResolvedValueOnce(3).mockResolvedValueOnce(4);

    const r = await getTenantSelfInfo(TENANT_ID);

    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.id).toBe(TENANT_ID);
    expect(r.activeUserCount).toBe(3);
    // 2026-06-03 (案A): seatUsageCount は有効+招待中で activeUserCount 以上になり得る
    expect(r.seatUsageCount).toBe(4);
    expect(r.plan).toBe('expert');
    // expert プランは Beginner 期限の対象外なので null
    expect(r.beginnerDaysRemaining).toBeNull();
    expect(r.beginnerExpiryState).toBe('active');
  });

  // feat/settings-tenant-identity (2026-05-21): slug + 価格定数 + 停止状態を返す
  it('feat/settings-tenant-identity: slug / pricePerCallHaiku / pricePerCallSonnet / suspendedAt / suspendReason / createdAt を返す', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(baseTenant as never);
    vi.mocked(prisma.user.count).mockResolvedValueOnce(0);

    const r = await getTenantSelfInfo(TENANT_ID);

    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.slug).toBe('test-tenant');
    expect(r.pricePerCallHaiku).toBe(10); // ADR-0019: Expert ¥5 → ¥10
    expect(r.pricePerCallSonnet).toBe(15); // 据置
    expect(r.suspendedAt).toBeNull();
    expect(r.suspendReason).toBeNull();
    expect(r.createdAt).toEqual(new Date('2026-01-01T00:00:00Z'));
  });

  it('feat/settings-tenant-identity: 停止中テナントは suspendedAt + suspendReason を返す', async () => {
    const suspendedAt = new Date('2026-05-19T00:00:00Z');
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      ...baseTenant,
      suspendedAt,
      suspendReason: 'payment_delinquent',
    } as never);
    vi.mocked(prisma.user.count).mockResolvedValueOnce(0);

    const r = await getTenantSelfInfo(TENANT_ID);

    expect(r?.suspendedAt).toEqual(suspendedAt);
    expect(r?.suspendReason).toBe('payment_delinquent');
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

  // PR-V7 #3 (2026-05-19): credit_card → invoice revert で Stripe Subscription キャンセル
  describe('PR-V7 #3: paymentMethod revert (credit_card → invoice)', () => {
    it('STRIPE_ENABLED=false なら cancelTenantStripeSubscription を呼ばない (= 既存挙動維持)', async () => {
      vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
        paymentMethod: 'credit_card',
        stripeSubscriptionId: 'sub_xxx',
      } as never);

      await updateBillingContact(TENANT_ID, { paymentMethod: 'invoice' });

      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: TENANT_ID },
        data: { paymentMethod: 'invoice' },
      });
      expect(mockCancelTenantStripeSubscription).not.toHaveBeenCalled();
    });

    it('STRIPE_ENABLED=true + credit_card → invoice + stripeSubscriptionId あり → Stripe cancel 呼出', async () => {
      const stripeLib = await import('@/lib/stripe');
      vi.mocked(stripeLib.isStripeEnabled).mockReturnValueOnce(true);
      vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
        paymentMethod: 'credit_card',
        stripeSubscriptionId: 'sub_xxx',
      } as never);
      mockCancelTenantStripeSubscription.mockResolvedValueOnce({
        ok: true,
        value: { canceled: true },
      });

      await updateBillingContact(TENANT_ID, { paymentMethod: 'invoice' });

      expect(mockCancelTenantStripeSubscription).toHaveBeenCalledWith(TENANT_ID);
      // 失敗 auditLog は記録されない (= 成功時)
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('元から invoice (= 遷移なし) なら Stripe cancel を呼ばない', async () => {
      const stripeLib = await import('@/lib/stripe');
      vi.mocked(stripeLib.isStripeEnabled).mockReturnValueOnce(true);
      vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
        paymentMethod: 'invoice',
        stripeSubscriptionId: null,
      } as never);

      await updateBillingContact(TENANT_ID, { paymentMethod: 'invoice' });

      expect(mockCancelTenantStripeSubscription).not.toHaveBeenCalled();
    });

    it('credit_card で stripeSubscriptionId なし (= setup 失敗等) → cancel 不要', async () => {
      const stripeLib = await import('@/lib/stripe');
      vi.mocked(stripeLib.isStripeEnabled).mockReturnValueOnce(true);
      vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
        paymentMethod: 'credit_card',
        stripeSubscriptionId: null,
      } as never);

      await updateBillingContact(TENANT_ID, { paymentMethod: 'invoice' });

      expect(mockCancelTenantStripeSubscription).not.toHaveBeenCalled();
    });

    it('Stripe cancel 失敗時は auditLog に記録するが、DB 更新自体は成功扱い', async () => {
      const stripeLib = await import('@/lib/stripe');
      vi.mocked(stripeLib.isStripeEnabled).mockReturnValueOnce(true);
      vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
        paymentMethod: 'credit_card',
        stripeSubscriptionId: 'sub_xxx',
      } as never);
      mockCancelTenantStripeSubscription.mockResolvedValueOnce({
        ok: false,
        code: 'connection',
        userMessage: 'Stripe 接続失敗',
      });

      await updateBillingContact(TENANT_ID, { paymentMethod: 'invoice' });

      expect(prisma.tenant.update).toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalled();
      const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0];
      expect(call?.data.afterValue).toMatchObject({
        stripeCancelFailed: true,
        transition: 'credit_card_to_invoice',
        severity: 'requires_manual_action',
      });
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

  // ADR-0030 (2026-05-30): Embedding 月次予算上限の CRUD + Beginner 拒否テスト
  it('ADR-0030: monthlyEmbeddingBudgetCapJpy が負数なら INVALID_BUDGET', async () => {
    const r = await updateTenantSelf(TENANT_ID, { monthlyEmbeddingBudgetCapJpy: -1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('INVALID_BUDGET');
    expect(prisma.tenant.findFirstOrThrow).not.toHaveBeenCalled();
  });

  it('ADR-0030: plan 未指定 + monthlyEmbeddingBudgetCapJpy 指定: 即時反映する', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce({
      ...baseTenant,
      plan: 'expert',
    } as never);

    const r = await updateTenantSelf(TENANT_ID, { monthlyEmbeddingBudgetCapJpy: 3000 });

    expect(r.ok).toBe(true);
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { monthlyEmbeddingBudgetCapJpy: 3000 },
    });
  });

  it('ADR-0030: 現プラン Beginner で Embedding budget (非 null) 指定: BEGINNER_EMBEDDING_BUDGET_NOT_ALLOWED', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce({
      ...baseTenant,
      plan: 'beginner',
      beginnerEverUpgraded: false,
    } as never);

    const r = await updateTenantSelf(TENANT_ID, { monthlyEmbeddingBudgetCapJpy: 3000 });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('BEGINNER_EMBEDDING_BUDGET_NOT_ALLOWED');
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('ADR-0030: 現プラン Beginner で Embedding budget=null 指定: 通る (残値クリアの救済)', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce({
      ...baseTenant,
      plan: 'beginner',
      beginnerEverUpgraded: false,
      monthlyEmbeddingBudgetCapJpy: 1000,
    } as never);

    const r = await updateTenantSelf(TENANT_ID, { monthlyEmbeddingBudgetCapJpy: null });

    expect(r.ok).toBe(true);
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { monthlyEmbeddingBudgetCapJpy: null },
    });
  });

  it('ADR-0030: LLM cap + Embedding cap 同時指定で両方反映', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce({
      ...baseTenant,
      plan: 'pro',
    } as never);

    const r = await updateTenantSelf(TENANT_ID, {
      monthlyBudgetCapJpy: 5000,
      monthlyEmbeddingBudgetCapJpy: 3000,
    });

    expect(r.ok).toBe(true);
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { monthlyBudgetCapJpy: 5000, monthlyEmbeddingBudgetCapJpy: 3000 },
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

  // feat/billing-conditional-by-plan (2026-06-05): 有料化時の請求先完全性ガード (両方向)。
  //   Beginner は請求先を省略できるため、有料プラン化の瞬間に未入力なら拒否する。
  it('有料化 (Beginner→Expert) で請求先住所が欠けていれば BILLING_INFO_INCOMPLETE', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce({
      ...baseTenant,
      plan: 'beginner',
      beginnerEverUpgraded: false,
      billingPostalCode: null,
      billingPrefecture: null,
      billingCity: null,
      billingStreetAddress: null,
    } as never);
    const r = await updateTenantSelf(TENANT_ID, { plan: 'expert' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('BILLING_INFO_INCOMPLETE');
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('有料化 (Beginner→Expert) で請求先住所が揃っていれば成功', async () => {
    // baseTenant は請求先完備 (postal/prefecture/city/street + corporate 会社名あり)
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce({
      ...baseTenant,
      plan: 'beginner',
      beginnerEverUpgraded: false,
    } as never);
    const r = await updateTenantSelf(TENANT_ID, { plan: 'expert' });
    expect(r.ok).toBe(true);
  });

  it('Expert↔Pro 切替でも請求先住所が欠けていれば BILLING_INFO_INCOMPLETE', async () => {
    vi.mocked(prisma.tenant.findFirstOrThrow).mockResolvedValueOnce({
      ...baseTenant,
      billingStreetAddress: null,
    } as never);
    const r = await updateTenantSelf(TENANT_ID, { plan: 'pro' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('BILLING_INFO_INCOMPLETE');
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
