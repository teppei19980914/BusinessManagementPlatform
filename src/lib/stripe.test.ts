/**
 * src/lib/stripe.ts の単体テスト (PR-S2 / 2026-05-14)
 *
 * 検証観点:
 *   - isStripeEnabled() が環境変数で切り替わる
 *   - getStripePriceConfig() が 4 つの Price ID を返す
 *   - 環境変数欠落時は throw
 *   - getStoragePriceId() のプラン名 → Price ID マッピング
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isStripeEnabled,
  getStripePriceConfig,
  getStoragePriceId,
  getStripeWebhookSecret,
  getSystemUserId,
  resetStripeClient,
  STRIPE_API_VERSION,
} from './stripe';

describe('isStripeEnabled', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env['STRIPE_ENABLED'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("STRIPE_ENABLED='true' のときのみ true", () => {
    process.env['STRIPE_ENABLED'] = 'true';
    expect(isStripeEnabled()).toBe(true);
  });

  it('STRIPE_ENABLED 未設定なら false', () => {
    expect(isStripeEnabled()).toBe(false);
  });

  it("STRIPE_ENABLED='false' なら false", () => {
    process.env['STRIPE_ENABLED'] = 'false';
    expect(isStripeEnabled()).toBe(false);
  });

  it("STRIPE_ENABLED='1' は false (= 厳密に 'true' のみ)", () => {
    process.env['STRIPE_ENABLED'] = '1';
    expect(isStripeEnabled()).toBe(false);
  });
});

describe('STRIPE_API_VERSION', () => {
  it("固定値 '2024-12-18.acacia' (= ADR-0006 準拠)", () => {
    expect(STRIPE_API_VERSION).toBe('2024-12-18.acacia');
  });
});

describe('getStripePriceConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env['STRIPE_PRICE_HAIKU'];
    delete process.env['STRIPE_PRICE_SONNET'];
    delete process.env['STRIPE_PRICE_STORAGE_PLUS'];
    delete process.env['STRIPE_PRICE_STORAGE_PRO'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('全環境変数がセットされていれば 4 つの ID を返す', () => {
    process.env['STRIPE_PRICE_HAIKU'] = 'price_haiku_1';
    process.env['STRIPE_PRICE_SONNET'] = 'price_sonnet_2';
    process.env['STRIPE_PRICE_STORAGE_PLUS'] = 'price_plus_3';
    process.env['STRIPE_PRICE_STORAGE_PRO'] = 'price_pro_4';
    const config = getStripePriceConfig();
    expect(config).toEqual({
      haiku: 'price_haiku_1',
      sonnet: 'price_sonnet_2',
      storagePlus: 'price_plus_3',
      storagePro: 'price_pro_4',
    });
  });

  it('1 つでも未設定なら throw', () => {
    process.env['STRIPE_PRICE_HAIKU'] = 'price_haiku_1';
    process.env['STRIPE_PRICE_SONNET'] = 'price_sonnet_2';
    process.env['STRIPE_PRICE_STORAGE_PLUS'] = 'price_plus_3';
    // STORAGE_PRO 欠落
    expect(() => getStripePriceConfig()).toThrow('STRIPE_PRICE_*');
  });

  it('全部未設定なら throw', () => {
    expect(() => getStripePriceConfig()).toThrow('STRIPE_PRICE_*');
  });
});

describe('getStoragePriceId', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env['STRIPE_PRICE_HAIKU'] = 'price_haiku';
    process.env['STRIPE_PRICE_SONNET'] = 'price_sonnet';
    process.env['STRIPE_PRICE_STORAGE_PLUS'] = 'price_plus';
    process.env['STRIPE_PRICE_STORAGE_PRO'] = 'price_pro';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("'standard' → null (= Subscription Item を作らない)", () => {
    expect(getStoragePriceId('standard')).toBe(null);
  });

  it("'plus' → STRIPE_PRICE_STORAGE_PLUS", () => {
    expect(getStoragePriceId('plus')).toBe('price_plus');
  });

  it("'pro_storage' → STRIPE_PRICE_STORAGE_PRO", () => {
    expect(getStoragePriceId('pro_storage')).toBe('price_pro');
  });

  it('想定外値 → null (= 安全側、Subscription Item を作らない)', () => {
    expect(getStoragePriceId('unknown_plan')).toBe(null);
  });
});

describe('getStripeWebhookSecret', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env['STRIPE_WEBHOOK_SECRET'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('未設定なら throw', () => {
    expect(() => getStripeWebhookSecret()).toThrow('STRIPE_WEBHOOK_SECRET');
  });

  it('空文字なら throw', () => {
    process.env['STRIPE_WEBHOOK_SECRET'] = '';
    expect(() => getStripeWebhookSecret()).toThrow('STRIPE_WEBHOOK_SECRET');
  });

  it('セットされていれば値を返す', () => {
    process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_test_xxx';
    expect(getStripeWebhookSecret()).toBe('whsec_test_xxx');
  });
});

describe('getSystemUserId', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env['SYSTEM_USER_ID'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('未設定なら throw', () => {
    expect(() => getSystemUserId()).toThrow('SYSTEM_USER_ID');
  });

  it('セットされていれば値を返す', () => {
    process.env['SYSTEM_USER_ID'] = '00000000-0000-0000-0000-systemsystemid';
    expect(getSystemUserId()).toBe('00000000-0000-0000-0000-systemsystemid');
  });
});

describe('resetStripeClient', () => {
  it('呼出して例外が出ない (= テスト用ヘルパ)', () => {
    expect(() => resetStripeClient()).not.toThrow();
  });
});
