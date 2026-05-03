import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyRateLimit, _resetRateLimitBucketsForTest } from './rate-limit';
import { NextRequest } from 'next/server';

function makeReq(ip: string = '203.0.113.1'): NextRequest {
  // NextRequest を直接 mock するのは難しいので最低限のヘッダのみ持つオブジェクトをキャスト
  return {
    headers: {
      get: (name: string) => (name === 'x-forwarded-for' ? ip : null),
    },
  } as unknown as NextRequest;
}

describe('applyRateLimit', () => {
  beforeEach(() => {
    _resetRateLimitBucketsForTest();
    vi.useRealTimers();
  });

  it('閾値内のリクエストは null を返し通過させる', () => {
    const req = makeReq();
    for (let i = 0; i < 10; i++) {
      expect(applyRateLimit(req, { key: 'test' })).toBeNull();
    }
  });

  it('閾値超過 (11 回目) で 429 を返す', () => {
    const req = makeReq();
    for (let i = 0; i < 10; i++) {
      applyRateLimit(req, { key: 'test' });
    }
    const res = applyRateLimit(req, { key: 'test' });
    expect(res).not.toBeNull();
    expect(res?.status).toBe(429);
  });

  it('429 レスポンスに Retry-After ヘッダが付く', () => {
    const req = makeReq();
    for (let i = 0; i < 10; i++) {
      applyRateLimit(req, { key: 'test' });
    }
    const res = applyRateLimit(req, { key: 'test' });
    expect(res?.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(res?.headers.get('X-RateLimit-Limit')).toBe('10');
    expect(res?.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('window 経過後にカウンタがリセットされる', () => {
    vi.useFakeTimers();
    const req = makeReq();
    for (let i = 0; i < 10; i++) {
      applyRateLimit(req, { key: 'test' });
    }
    expect(applyRateLimit(req, { key: 'test' })?.status).toBe(429);

    // 5 分 + 1 秒進める
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
    expect(applyRateLimit(req, { key: 'test' })).toBeNull();
  });

  it('別 IP は別バケット (片方だけ制限してもう片方は通過)', () => {
    const req1 = makeReq('203.0.113.1');
    const req2 = makeReq('203.0.113.2');
    for (let i = 0; i < 10; i++) {
      applyRateLimit(req1, { key: 'test' });
    }
    expect(applyRateLimit(req1, { key: 'test' })?.status).toBe(429);
    expect(applyRateLimit(req2, { key: 'test' })).toBeNull();
  });

  it('別 key は別バケット (同 IP でも経路ごとに独立)', () => {
    const req = makeReq();
    for (let i = 0; i < 10; i++) {
      applyRateLimit(req, { key: 'reset-password' });
    }
    expect(applyRateLimit(req, { key: 'reset-password' })?.status).toBe(429);
    expect(applyRateLimit(req, { key: 'lock-status' })).toBeNull();
  });

  it('カスタム max / windowMs を尊重する', () => {
    const req = makeReq();
    for (let i = 0; i < 3; i++) {
      expect(applyRateLimit(req, { key: 't', max: 3, windowMs: 1000 })).toBeNull();
    }
    expect(applyRateLimit(req, { key: 't', max: 3, windowMs: 1000 })?.status).toBe(429);
  });

  it('x-forwarded-for が複数 IP の場合は先頭 (真の client) を採用', () => {
    const req = {
      headers: {
        get: (name: string) =>
          name === 'x-forwarded-for' ? '203.0.113.5, 10.0.0.1, 10.0.0.2' : null,
      },
    } as unknown as NextRequest;
    for (let i = 0; i < 10; i++) {
      applyRateLimit(req, { key: 'test' });
    }
    expect(applyRateLimit(req, { key: 'test' })?.status).toBe(429);
    // 先頭 IP が違えば独立バケット
    const reqOther = makeReq('198.51.100.1');
    expect(applyRateLimit(reqOther, { key: 'test' })).toBeNull();
  });
});
