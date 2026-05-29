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
  it("固定値 '2026-04-22.dahlia' (= PR-V8 / 2026-05-19 更新、Meter API 対応)", () => {
    expect(STRIPE_API_VERSION).toBe('2026-04-22.dahlia');
  });
});

describe('getStripePriceConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env['STRIPE_PRICE_HAIKU'];
    delete process.env['STRIPE_PRICE_SONNET'];
    delete process.env['STRIPE_PRICE_EMBEDDING'];
    delete process.env['STRIPE_PRICE_DB_CAPACITY_OVERAGE'];
    delete process.env['STRIPE_PRICE_STORAGE_FILE_OVERAGE'];
    // chore/storage-addon-backend-removal (2026-05-26): STRIPE_PRICE_STORAGE_PLUS / PRO は撤去済
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('必須環境変数のみセットされていれば 2 つの ID + 3 つの undefined を返す (= Stripe-ready 旧挙動互換)', () => {
    process.env['STRIPE_PRICE_HAIKU'] = 'price_haiku_1';
    process.env['STRIPE_PRICE_SONNET'] = 'price_sonnet_2';
    const config = getStripePriceConfig();
    expect(config).toEqual({
      haiku: 'price_haiku_1',
      sonnet: 'price_sonnet_2',
      embedding: undefined,
      dbCapacityOverage: undefined,
      storageFileOverage: undefined,
    });
  });

  it('optional 3 つ全部セット済なら 5 つの ID を返す (= ADR-0022/0020/0021 Stripe 有効化時)', () => {
    process.env['STRIPE_PRICE_HAIKU'] = 'price_haiku_1';
    process.env['STRIPE_PRICE_SONNET'] = 'price_sonnet_2';
    process.env['STRIPE_PRICE_EMBEDDING'] = 'price_embedding_3';
    process.env['STRIPE_PRICE_DB_CAPACITY_OVERAGE'] = 'price_db_capacity_4';
    process.env['STRIPE_PRICE_STORAGE_FILE_OVERAGE'] = 'price_storage_file_5';
    const config = getStripePriceConfig();
    expect(config).toEqual({
      haiku: 'price_haiku_1',
      sonnet: 'price_sonnet_2',
      embedding: 'price_embedding_3',
      dbCapacityOverage: 'price_db_capacity_4',
      storageFileOverage: 'price_storage_file_5',
    });
  });

  it('optional 環境変数は空文字列なら undefined 扱い (Netlify env 空保存対策)', () => {
    process.env['STRIPE_PRICE_HAIKU'] = 'price_haiku_1';
    process.env['STRIPE_PRICE_SONNET'] = 'price_sonnet_2';
    process.env['STRIPE_PRICE_EMBEDDING'] = '';
    process.env['STRIPE_PRICE_DB_CAPACITY_OVERAGE'] = '';
    process.env['STRIPE_PRICE_STORAGE_FILE_OVERAGE'] = '';
    const config = getStripePriceConfig();
    expect(config.embedding).toBeUndefined();
    expect(config.dbCapacityOverage).toBeUndefined();
    expect(config.storageFileOverage).toBeUndefined();
  });

  it('1 つでも必須未設定なら throw', () => {
    process.env['STRIPE_PRICE_HAIKU'] = 'price_haiku_1';
    // SONNET 欠落
    expect(() => getStripePriceConfig()).toThrow('STRIPE_PRICE_*');
  });

  it('全部未設定なら throw', () => {
    expect(() => getStripePriceConfig()).toThrow('STRIPE_PRICE_*');
  });
});

// chore/storage-addon-backend-removal (2026-05-26):
//   getStoragePriceId は撤去 (ADR-0020/0021 で従量課金化、Stripe Subscription は Haiku/Sonnet の 2 Meter のみ)

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
