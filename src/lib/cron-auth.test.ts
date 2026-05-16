/**
 * 2026-05-13 (security/auth-secret-hardening, B-6): cron 認可ヘルパの単体テスト。
 *   - 定数時間比較 (timingSafeEqual) の挙動 (一致/不一致)
 *   - CRON_SECRET 未設定 / 短すぎる時の fail-closed
 *   - 異なる長さの header での即拒否 (timingSafeEqual の throw を回避)
 *   - Authorization ヘッダ無しでの拒否
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { isCronAuthorized, checkCronAuthorization } from './cron-auth';

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

// 2026-05-18 (PR feat/cron-execution-log): result type を返す新 API。
//   route 側で「設定誤りの内訳」を診断できるようにするため、失敗理由を区別して返す。
describe('checkCronAuthorization', () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.CRON_SECRET;
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  it('server_secret_missing: CRON_SECRET 未設定', () => {
    delete process.env.CRON_SECRET;
    expect(checkCronAuthorization(makeReq(`Bearer ${VALID_SECRET}`))).toEqual({
      ok: false,
      reason: 'server_secret_missing',
    });
  });

  it('server_secret_missing: CRON_SECRET が短すぎる', () => {
    process.env.CRON_SECRET = 'short';
    expect(checkCronAuthorization(makeReq('Bearer short'))).toEqual({
      ok: false,
      reason: 'server_secret_missing',
    });
  });

  it('no_bearer_header: Authorization ヘッダなし', () => {
    process.env.CRON_SECRET = VALID_SECRET;
    expect(checkCronAuthorization(makeReq(null))).toEqual({
      ok: false,
      reason: 'no_bearer_header',
    });
  });

  it('invalid_bearer_format: Bearer prefix が無い', () => {
    // cron-job.org 設定で `Bearer ` プレフィックスを書き忘れた誤設定パターン
    process.env.CRON_SECRET = VALID_SECRET;
    expect(checkCronAuthorization(makeReq(VALID_SECRET))).toEqual({
      ok: false,
      reason: 'invalid_bearer_format',
    });
  });

  it('invalid_bearer_format: 小文字 bearer は受理しない', () => {
    process.env.CRON_SECRET = VALID_SECRET;
    expect(checkCronAuthorization(makeReq(`bearer ${VALID_SECRET}`))).toEqual({
      ok: false,
      reason: 'invalid_bearer_format',
    });
  });

  it('secret_mismatch: Bearer 形式 OK だが secret が違う (同長)', () => {
    process.env.CRON_SECRET = VALID_SECRET;
    const wrong = 'B'.repeat(40);
    expect(checkCronAuthorization(makeReq(`Bearer ${wrong}`))).toEqual({
      ok: false,
      reason: 'secret_mismatch',
    });
  });

  it('secret_mismatch: Bearer 形式 OK だが長さが違う', () => {
    process.env.CRON_SECRET = VALID_SECRET;
    expect(checkCronAuthorization(makeReq('Bearer short'))).toEqual({
      ok: false,
      reason: 'secret_mismatch',
    });
  });

  it('ok=true: 完全一致', () => {
    process.env.CRON_SECRET = VALID_SECRET;
    expect(checkCronAuthorization(makeReq(`Bearer ${VALID_SECRET}`))).toEqual({
      ok: true,
    });
  });
});
