/**
 * stripe-payment-method-section の単体テスト (PR-S5 / 2026-05-14)
 *
 * RTL は導入していないため、Component レンダリングは検証せず
 * 状態判定の純関数 `deriveStripeState` だけテストする。
 *
 * 検証観点 (STRIPE_PAYMENT_UI.md §2.2):
 *   - 状態 A: invoice / bank_transfer
 *   - 状態 C: credit_card + cardVerificationStatus = 'valid' + autoSuspend なし
 *   - 状態 D: credit_card かつ「期限切れ / 拒否 / 未検証 / autoSuspend 予定あり」のいずれか
 */

import { describe, it, expect } from 'vitest';
import { deriveStripeState, type StripePaymentInfo } from './stripe-payment-method-section';

function buildInfo(overrides: Partial<StripePaymentInfo> = {}): StripePaymentInfo {
  return {
    paymentMethod: 'invoice',
    stripeCustomerId: null,
    stripeSubscriptionStatus: null,
    stripeDefaultPaymentMethodId: null,
    cardVerificationStatus: null,
    cardLastVerifiedAt: null,
    autoSuspendScheduledAt: null,
    ...overrides,
  };
}

describe('deriveStripeState', () => {
  it('paymentMethod=invoice なら A_invoice', () => {
    expect(deriveStripeState(buildInfo({ paymentMethod: 'invoice' }))).toBe('A_invoice');
  });

  it('paymentMethod=bank_transfer なら A_bank_transfer', () => {
    expect(deriveStripeState(buildInfo({ paymentMethod: 'bank_transfer' }))).toBe('A_bank_transfer');
  });

  it('credit_card + valid + autoSuspend なし → C_active', () => {
    expect(
      deriveStripeState(
        buildInfo({
          paymentMethod: 'credit_card',
          cardVerificationStatus: 'valid',
          autoSuspendScheduledAt: null,
        }),
      ),
    ).toBe('C_active');
  });

  it('credit_card + expired → D_attention', () => {
    expect(
      deriveStripeState(
        buildInfo({
          paymentMethod: 'credit_card',
          cardVerificationStatus: 'expired',
        }),
      ),
    ).toBe('D_attention');
  });

  it('credit_card + declined → D_attention', () => {
    expect(
      deriveStripeState(
        buildInfo({
          paymentMethod: 'credit_card',
          cardVerificationStatus: 'declined',
        }),
      ),
    ).toBe('D_attention');
  });

  it('credit_card + never_verified → D_attention', () => {
    expect(
      deriveStripeState(
        buildInfo({
          paymentMethod: 'credit_card',
          cardVerificationStatus: 'never_verified',
        }),
      ),
    ).toBe('D_attention');
  });

  it('credit_card + valid だが autoSuspend 予定あり → D_attention (= 引落失敗中)', () => {
    expect(
      deriveStripeState(
        buildInfo({
          paymentMethod: 'credit_card',
          cardVerificationStatus: 'valid',
          autoSuspendScheduledAt: new Date(),
        }),
      ),
    ).toBe('D_attention');
  });

  it('credit_card + cardVerificationStatus=null → D_attention (= 検証履歴なし扱い)', () => {
    expect(
      deriveStripeState(
        buildInfo({
          paymentMethod: 'credit_card',
          cardVerificationStatus: null,
        }),
      ),
    ).toBe('D_attention');
  });

  it('paymentMethod=未知の値 (= 想定外) → A_invoice (= 安全側 fallback)', () => {
    expect(deriveStripeState(buildInfo({ paymentMethod: 'unknown_method' }))).toBe('A_invoice');
  });
});
