/**
 * tab-helpers.test.ts (feat/tenant-settings-tabs / 2026-05-22)
 *
 * 検証観点:
 *   1. pickInitialTab — 不正値 / null / undefined / 想定外文字列の安全な fallback
 *   2. buildStripeCleanedUrl — stripe_setup と reason のみ除去し、tab 等は保持
 *
 * Why: テナント設定画面の URL 同期ロジックは
 *   - Stripe Checkout 戻り (= 外部から制御不能なクエリが付与される)
 *   - 手動で URL を打ち込んだ管理者 (= 旧 URL / 不正値が混入する可能性)
 *   の 2 系統から不正値を受け取り得る。fallback 漏れがあると画面崩壊 (= 影響範囲: 全テナント管理者)
 *   になるため、ヘルパ関数自体に明示的な境界条件テストを当てる。
 */

import { describe, it, expect } from 'vitest';
import {
  buildStripeCleanedUrl,
  pickInitialTab,
  TENANT_SETTINGS_TABS,
} from './tab-helpers';

describe('pickInitialTab', () => {
  it('overview を返す: null / undefined / 空文字', () => {
    expect(pickInitialTab(null)).toBe('overview');
    expect(pickInitialTab(undefined)).toBe('overview');
    expect(pickInitialTab('')).toBe('overview');
  });

  it('既知のタブ識別子をそのまま返す', () => {
    expect(pickInitialTab('overview')).toBe('overview');
    expect(pickInitialTab('usage')).toBe('usage');
    expect(pickInitialTab('billing')).toBe('billing');
  });

  it('未知の文字列は overview に fallback (= 防御層)', () => {
    expect(pickInitialTab('unknown')).toBe('overview');
    expect(pickInitialTab('admin')).toBe('overview');
    expect(pickInitialTab('OVERVIEW')).toBe('overview'); // 大文字区別あり
    expect(pickInitialTab(' overview ')).toBe('overview'); // trim しない
  });

  it('TENANT_SETTINGS_TABS と整合性が取れている (= リファクタ耐性)', () => {
    for (const tab of TENANT_SETTINGS_TABS) {
      expect(pickInitialTab(tab)).toBe(tab);
    }
  });
});

describe('buildStripeCleanedUrl', () => {
  it('クエリなしなら /settings/tenant', () => {
    expect(buildStripeCleanedUrl(new URLSearchParams())).toBe('/settings/tenant');
  });

  it('stripe_setup のみ → 除去して /settings/tenant', () => {
    const params = new URLSearchParams('stripe_setup=success');
    expect(buildStripeCleanedUrl(params)).toBe('/settings/tenant');
  });

  it('stripe_setup + reason 両方 → 両方除去', () => {
    const params = new URLSearchParams('stripe_setup=failed&reason=card_declined');
    expect(buildStripeCleanedUrl(params)).toBe('/settings/tenant');
  });

  it('tab=billing は保持しつつ stripe_setup を除去 (= 本機能の核)', () => {
    const params = new URLSearchParams('tab=billing&stripe_setup=success');
    expect(buildStripeCleanedUrl(params)).toBe('/settings/tenant?tab=billing');
  });

  it('tab=usage + reason → tab だけ残る', () => {
    const params = new URLSearchParams('tab=usage&stripe_setup=failed&reason=expired_card');
    expect(buildStripeCleanedUrl(params)).toBe('/settings/tenant?tab=usage');
  });

  it('未知のクエリも保持 (= ホワイトリスト方式ではなく除去対象だけ delete)', () => {
    const params = new URLSearchParams('tab=billing&utm_source=email&stripe_setup=success');
    const result = buildStripeCleanedUrl(params);
    // URLSearchParams の serialize 順は insertion order を保つ。
    // utm_source は除去対象外なので残り、stripe_setup だけ消える。
    expect(result).toBe('/settings/tenant?tab=billing&utm_source=email');
  });

  it('toString() を持つ任意オブジェクトを受け付ける (= Next.js ReadonlyURLSearchParams 互換)', () => {
    const fakeSearchParams = {
      toString: () => 'tab=billing&stripe_setup=success',
    };
    expect(buildStripeCleanedUrl(fakeSearchParams)).toBe('/settings/tenant?tab=billing');
  });
});
