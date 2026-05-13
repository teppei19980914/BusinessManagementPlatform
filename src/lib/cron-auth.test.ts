/**
 * 2026-05-13 (security/auth-secret-hardening, B-6): cron 認可ヘルパの単体テスト。
 *   - 定数時間比較 (timingSafeEqual) の挙動 (一致/不一致)
 *   - CRON_SECRET 未設定 / 短すぎる時の fail-closed
 *   - 異なる長さの header での即拒否 (timingSafeEqual の throw を回避)
 *   - Authorization ヘッダ無しでの拒否
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { isCronAuthorized } from './cron-auth';

function makeReq(authHeader: string | null): NextRequest {
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'authorization' ? authHeader : null,
    },
  } as unknown as NextRequest;
}

const VALID_SECRET = 'A'.repeat(40); // 40 文字 (>= 32 の最小長)

describe('isCronAuthorized', () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.CRON_SECRET;
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  it('CRON_SECRET 未設定なら常に false (fail-closed)', () => {
    delete process.env.CRON_SECRET;
    expect(isCronAuthorized(makeReq(`Bearer ${VALID_SECRET}`))).toBe(false);
  });

  it('CRON_SECRET が短すぎる (< 32 文字) なら常に false', () => {
    process.env.CRON_SECRET = 'short';
    expect(isCronAuthorized(makeReq('Bearer short'))).toBe(false);
  });

  it('Authorization ヘッダ無しなら false', () => {
    process.env.CRON_SECRET = VALID_SECRET;
    expect(isCronAuthorized(makeReq(null))).toBe(false);
  });

  it('ヘッダ長が期待値と異なれば false (timingSafeEqual の throw を回避)', () => {
    process.env.CRON_SECRET = VALID_SECRET;
    expect(isCronAuthorized(makeReq('Bearer short-value'))).toBe(false);
    expect(
      isCronAuthorized(makeReq(`Bearer ${'A'.repeat(100)}`)),
    ).toBe(false);
  });

  it('一致しないヘッダは false (定数時間比較)', () => {
    process.env.CRON_SECRET = VALID_SECRET;
    // 同じ長さで内容のみ異なる
    const wrongSecret = 'B'.repeat(40);
    expect(isCronAuthorized(makeReq(`Bearer ${wrongSecret}`))).toBe(false);
  });

  it('完全一致のヘッダは true', () => {
    process.env.CRON_SECRET = VALID_SECRET;
    expect(isCronAuthorized(makeReq(`Bearer ${VALID_SECRET}`))).toBe(true);
  });

  it('プレフィックスのみ正しい (Bearer 抜け) は false', () => {
    process.env.CRON_SECRET = VALID_SECRET;
    expect(isCronAuthorized(makeReq(VALID_SECRET))).toBe(false);
  });
});
