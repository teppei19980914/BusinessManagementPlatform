import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';

import {
  InMemoryRateLimiter,
  _setDefaultRateLimiterForTest,
  getDefaultRateLimiter,
  type RateLimiter,
} from './rate-limiter';

describe('InMemoryRateLimiter', () => {
  let rl: InMemoryRateLimiter;

  beforeEach(() => {
    rl = new InMemoryRateLimiter();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-02T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('初回呼び出しは許可される', async () => {
    const result = await rl.check('user:1', { limit: 3, windowSec: 60 });
    expect(result.allowed).toBe(true);
  });

  it('limit 内の連続呼び出しは全て許可される', async () => {
    expect((await rl.check('user:1', { limit: 3, windowSec: 60 })).allowed).toBe(true);
    expect((await rl.check('user:1', { limit: 3, windowSec: 60 })).allowed).toBe(true);
    expect((await rl.check('user:1', { limit: 3, windowSec: 60 })).allowed).toBe(true);
  });

  it('limit 到達後の呼び出しは拒否され retryAfterSec を返す', async () => {
    // 3 件消費
    await rl.check('user:1', { limit: 3, windowSec: 60 });
    await rl.check('user:1', { limit: 3, windowSec: 60 });
    await rl.check('user:1', { limit: 3, windowSec: 60 });

    const denied = await rl.check('user:1', { limit: 3, windowSec: 60 });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('拒否時はカウンタが増えない (再試行しても retryAfter が変わらない)', async () => {
    await rl.check('user:1', { limit: 1, windowSec: 60 });
    const r1 = await rl.check('user:1', { limit: 1, windowSec: 60 });
    expect(r1.allowed).toBe(false);
    const r2 = await rl.check('user:1', { limit: 1, windowSec: 60 });
    expect(r2.allowed).toBe(false);
    // bucket の count は 1 のまま (テスト helper で観察)
    const bucket = rl._peekForTest('user:1');
    expect(bucket?.count).toBe(1);
  });

  it('window 経過後は新しいバケットで許可される', async () => {
    await rl.check('user:1', { limit: 1, windowSec: 60 });
    expect((await rl.check('user:1', { limit: 1, windowSec: 60 })).allowed).toBe(false);

    vi.advanceTimersByTime(61 * 1000); // 61 秒進める
    expect((await rl.check('user:1', { limit: 1, windowSec: 60 })).allowed).toBe(true);
  });

  it('異なるキーは独立してカウントされる', async () => {
    await rl.check('user:1', { limit: 1, windowSec: 60 });
    expect((await rl.check('user:1', { limit: 1, windowSec: 60 })).allowed).toBe(false);
    expect((await rl.check('user:2', { limit: 1, windowSec: 60 })).allowed).toBe(true);
  });

  it('_resetForTest で全バケットがクリアされる', async () => {
    await rl.check('user:1', { limit: 1, windowSec: 60 });
    rl._resetForTest();
    expect((await rl.check('user:1', { limit: 1, windowSec: 60 })).allowed).toBe(true);
  });

  it('retryAfterSec は最小 1 秒 (端数切り上げ)', async () => {
    await rl.check('user:1', { limit: 1, windowSec: 60 });
    // window 末端 1ms 前の状況
    vi.advanceTimersByTime(60 * 1000 - 1);
    const r = await rl.check('user:1', { limit: 1, windowSec: 60 });
    expect(r.retryAfterSec).toBe(1);
  });
});

describe('getDefaultRateLimiter / _setDefaultRateLimiterForTest', () => {
  afterEach(() => {
    _setDefaultRateLimiterForTest(null);
  });

  it('singleton: 連続呼び出しで同じインスタンスを返す', () => {
    const a = getDefaultRateLimiter();
    const b = getDefaultRateLimiter();
    expect(a).toBe(b);
  });

  it('_setDefaultRateLimiterForTest で差し替え可能', () => {
    const fake: RateLimiter = {
      check: vi.fn().mockResolvedValue({ allowed: true }),
    };
    _setDefaultRateLimiterForTest(fake);
    expect(getDefaultRateLimiter()).toBe(fake);
  });

  it('null セット後は新しい InMemoryRateLimiter が遅延生成される', () => {
    const fake: RateLimiter = { check: vi.fn() };
    _setDefaultRateLimiterForTest(fake);
    _setDefaultRateLimiterForTest(null);
    const next = getDefaultRateLimiter();
    expect(next).not.toBe(fake);
    expect(next).toBeInstanceOf(InMemoryRateLimiter);
  });
});
