/**
 * stripe-payment-method-section の単体テスト (PR-S5 / 2026-05-14, PR #425 / 2026-05-21 改修)
 *
 * RTL は導入していないため、Component レンダリングは検証せず
 * 状態判定の純関数 `deriveStripeState` だけテストする。
 *
 * 検証観点 (STRIPE_PAYMENT_UI.md §2 PR #425 改修):
 *   - 'invoice_only': paymentMethod != 'credit_card' (= 銀行振込。旧 'bank_transfer' も同状態)
 *   - 'credit_card_unregistered': paymentMethod = 'credit_card' かつ stripeSubscriptionId = null
 *   - 'credit_card_active': paymentMethod = 'credit_card' + Subscription 有 + 検証成功 + autoSuspend なし
 *   - 'credit_card_attention': paymentMethod = 'credit_card' + Subscription 有 + 検証 NG or autoSuspend 予定あり
 *
 * 2026-05-15: 'bank_transfer' は 'invoice' に統合 (UI ラベル「銀行振込」, 内部値 'invoice')。
 *   既存 DB の旧 'bank_transfer' レコードも 'invoice_only' にフォールバックすることを検証する。
 */

import { describe, it, expect } from 'vitest';
import { deriveStripeState, type StripePaymentInfo } from './stripe-payment-method-section';

function buildInfo(overrides: Partial<StripePaymentInfo> = {}): StripePaymentInfo {
  return {
    paymentMethod: 'invoice',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    stripeDefaultPaymentMethodId: null,
    cardVerificationStatus: null,
    cardLastVerifiedAt: null,
    autoSuspendScheduledAt: null,
    ...overrides,
  };
}

describe('deriveStripeState (PR #425)', () => {
  it('paymentMethod=invoice なら invoice_only', () => {
    expect(deriveStripeState(buildInfo({ paymentMethod: 'invoice' }))).toBe('invoice_only');
  });

  it('paymentMethod=bank_transfer (旧値、既存 DB 互換) でも invoice_only にフォールバック', () => {
    expect(deriveStripeState(buildInfo({ paymentMethod: 'bank_transfer' }))).toBe('invoice_only');
  });

  it('credit_card + stripeSubscriptionId=null → credit_card_unregistered (= 初回登録待ち)', () => {
    expect(
      deriveStripeState(
        buildInfo({
          paymentMethod: 'credit_card',
          stripeSubscriptionId: null,
        }),
      ),
    ).toBe('credit_card_unregistered');
  });

  it('credit_card + Subscription 有 + valid + autoSuspend なし → credit_card_active', () => {
    expect(
      deriveStripeState(
        buildInfo({
          paymentMethod: 'credit_card',
          stripeSubscriptionId: 'sub_test_123',
          cardVerificationStatus: 'valid',
          autoSuspendScheduledAt: null,
        }),
      ),
    ).toBe('credit_card_active');
  });

  it('credit_card + Subscription 有 + expired → credit_card_attention', () => {
    expect(
      deriveStripeState(
        buildInfo({
          paymentMethod: 'credit_card',
          stripeSubscriptionId: 'sub_test_123',
          cardVerificationStatus: 'expired',
        }),
      ),
    ).toBe('credit_card_attention');
  });

  it('credit_card + Subscription 有 + declined → credit_card_attention', () => {
    expect(
      deriveStripeState(
        buildInfo({
          paymentMethod: 'credit_card',
          stripeSubscriptionId: 'sub_test_123',
          cardVerificationStatus: 'declined',
        }),
      ),
    ).toBe('credit_card_attention');
  });

  it('credit_card + Subscription 有 + never_verified → credit_card_attention', () => {
    expect(
      deriveStripeState(
        buildInfo({
          paymentMethod: 'credit_card',
          stripeSubscriptionId: 'sub_test_123',
          cardVerificationStatus: 'never_verified',
        }),
      ),
    ).toBe('credit_card_attention');
  });

  it('credit_card + Subscription 有 + valid だが autoSuspend 予定あり → credit_card_attention', () => {
    expect(
      deriveStripeState(
        buildInfo({
          paymentMethod: 'credit_card',
          stripeSubscriptionId: 'sub_test_123',
          cardVerificationStatus: 'valid',
          autoSuspendScheduledAt: new Date(),
        }),
      ),
    ).toBe('credit_card_attention');
  });

  it('credit_card + Subscription 有 + cardVerificationStatus=null → credit_card_attention', () => {
    expect(
      deriveStripeState(
        buildInfo({
          paymentMethod: 'credit_card',
          stripeSubscriptionId: 'sub_test_123',
          cardVerificationStatus: null,
        }),
      ),
    ).toBe('credit_card_attention');
  });

  it('paymentMethod=未知の値 (= 想定外) → invoice_only (= 安全側 fallback)', () => {
    expect(deriveStripeState(buildInfo({ paymentMethod: 'unknown_method' }))).toBe('invoice_only');
  });
});
