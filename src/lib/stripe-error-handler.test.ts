/**
 * stripe-error-handler の単体テスト (PR-S2 / 2026-05-14)
 *
 * 検証観点:
 *   - withStripeError が成功時に Result.ok を返す
 *   - 各 Stripe エラー型を正しい code に変換する
 *   - card_declined は decline_code を伴う
 *   - authentication エラーで onAuthError コールバックが呼ばれる
 *   - 未知の Error は api_error 扱い
 */

import { describe, it, expect, vi } from 'vitest';
import Stripe from 'stripe';
import { withStripeError, mapStripeError } from './stripe-error-handler';

describe('withStripeError', () => {
  it('成功時は Result.ok=true で値を返す', async () => {
    const result = await withStripeError(async () => ({ id: 'sub_123' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ id: 'sub_123' });
  });

  it('StripeCardError → code=card_declined + decline_code + severity', async () => {
    const error = new Stripe.errors.StripeCardError({
      type: 'StripeCardError',
      message: 'Your card was declined.',
      decline_code: 'insufficient_funds',
      code: 'card_declined',
    } as unknown as Stripe.StripeRawError);
    const result = await withStripeError(async () => {
      throw error;
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'card_declined') {
      expect(result.declineCode).toBe('insufficient_funds');
      expect(result.userMessage).toContain('カード残高が不足');
      expect(result.severity).toBe('high');
    } else {
      throw new Error('expected card_declined');
    }
  });

  it('decline_code が unknown でもデフォルトメッセージを返す', async () => {
    const error = new Stripe.errors.StripeCardError({
      type: 'StripeCardError',
      message: 'declined',
      decline_code: 'super_unknown_xyz',
      code: 'card_declined',
    } as unknown as Stripe.StripeRawError);
    const result = await withStripeError(async () => {
      throw error;
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'card_declined') {
      expect(result.userMessage).toContain('詳細不明');
    }
  });

  it('StripeRateLimitError → code=rate_limit + retryAfterSec', async () => {
    const error = new Stripe.errors.StripeRateLimitError({
      type: 'StripeRateLimitError',
      message: 'Rate limited',
    } as unknown as Stripe.StripeRawError);
    const result = await withStripeError(async () => {
      throw error;
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'rate_limit') {
      expect(result.retryAfterSec).toBeGreaterThan(0);
    } else {
      throw new Error('expected rate_limit');
    }
  });

  it('StripeInvalidRequestError → code=invalid_request + detail', async () => {
    const error = new Stripe.errors.StripeInvalidRequestError({
      type: 'StripeInvalidRequestError',
      message: 'Missing required parameter: customer',
    } as unknown as Stripe.StripeRawError);
    const result = await withStripeError(async () => {
      throw error;
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'invalid_request') {
      expect(result.detail).toContain('Missing required parameter');
    }
  });

  it('StripeAuthenticationError → code=authentication + onAuthError 呼出', async () => {
    const error = new Stripe.errors.StripeAuthenticationError({
      type: 'StripeAuthenticationError',
      message: 'Invalid API Key',
    } as unknown as Stripe.StripeRawError);
    const onAuthError = vi.fn().mockResolvedValue(undefined);
    const result = await withStripeError(async () => {
      throw error;
    }, onAuthError);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('authentication');
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });

  it('onAuthError の throw は主処理を止めない (= 静かに無視)', async () => {
    const error = new Stripe.errors.StripeAuthenticationError({
      type: 'StripeAuthenticationError',
      message: 'Invalid API Key',
    } as unknown as Stripe.StripeRawError);
    const onAuthError = vi.fn().mockRejectedValue(new Error('alert failed'));
    const result = await withStripeError(async () => {
      throw error;
    }, onAuthError);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('authentication');
  });

  it('StripeConnectionError → code=connection', async () => {
    const error = new Stripe.errors.StripeConnectionError({
      type: 'StripeConnectionError',
      message: 'Network error',
    } as unknown as Stripe.StripeRawError);
    const result = await withStripeError(async () => {
      throw error;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('connection');
  });

  it('StripeAPIError / 未知の Error → code=api_error', async () => {
    const result1 = await withStripeError(async () => {
      throw new Stripe.errors.StripeAPIError({
        type: 'StripeAPIError',
        message: 'Internal error',
      } as unknown as Stripe.StripeRawError);
    });
    expect(result1.ok).toBe(false);
    if (!result1.ok) expect(result1.code).toBe('api_error');

    const result2 = await withStripeError(async () => {
      throw new Error('random error');
    });
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.code).toBe('api_error');
  });
});

describe('mapStripeError (= テスト容易性 export)', () => {
  it('既知のエラー型を直接マップできる', async () => {
    const error = new Stripe.errors.StripeRateLimitError({
      type: 'StripeRateLimitError',
      message: 'rate',
    } as unknown as Stripe.StripeRawError);
    const result = await mapStripeError(error);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('rate_limit');
  });
});
