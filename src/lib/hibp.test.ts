/**
 * HIBP k-anonymity API クライアント単体テスト
 *   security/phase-3 (2026-05-31)
 *
 * 検証ポイント:
 *   1. テスト環境 (NODE_ENV='test') では外部 fetch せず { pwned: false, count: 0 } を返す
 *   2. SKIP_HIBP='true' で明示的に skip 可能
 *   3. assertPasswordNotPwned は pwned=true なら PwnedPasswordError を throw
 *   4. (mock fetch) HIBP の k-anonymity レスポンスから自分の suffix 一致を判定可能
 *   5. (mock fetch) Add-Padding によるダミー行 (count=0) は pwned 扱いしない
 *   6. (mock fetch) HIBP 5xx / network error は fail-open
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { isPasswordPwned, assertPasswordNotPwned, PwnedPasswordError } from './hibp';

beforeEach(() => {
  // vi.stubEnv で設定した env を初期化 (NODE_ENV はデフォルト 'test' に戻る)
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('isPasswordPwned (default test environment)', () => {
  it('NODE_ENV=test では fetch せず { pwned: false, count: 0 } を返す', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await isPasswordPwned('any-password');
    expect(result).toEqual({ pwned: false, count: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('isPasswordPwned (production-like, mock fetch)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SKIP_HIBP', 'false');
  });

  function mockFetchResponse(body: string, ok = true, status = 200) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(body, { status, statusText: ok ? 'OK' : 'Internal Error' }) as never,
    );
  }

  it('自分の SHA-1 suffix が HIBP リストにあれば pwned=true', async () => {
    const password = 'P@ssw0rd!example';
    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const suffix = sha1.slice(5);
    // mock: 自 suffix と無関係 2 行 + 自 suffix:42 を返す
    mockFetchResponse(`ABCDE1234567890ABCDEF0123456789ABCD:7\n${suffix}:42\n`);

    const result = await isPasswordPwned(password);

    expect(result).toEqual({ pwned: true, count: 42 });
  });

  it('自分の suffix が無ければ pwned=false', async () => {
    mockFetchResponse('ABCDE1234567890ABCDEF0123456789ABCD:7\n');
    const result = await isPasswordPwned('未漏洩なパスワード!example');
    expect(result).toEqual({ pwned: false, count: 0 });
  });

  it('count=0 のダミー行 (Add-Padding) は pwned 扱いしない (fail-open 補完)', async () => {
    const password = 'edge-case';
    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const suffix = sha1.slice(5);
    mockFetchResponse(`${suffix}:0\n`);
    const result = await isPasswordPwned(password);
    expect(result).toEqual({ pwned: false, count: 0 });
  });

  it('HIBP 5xx 障害時は fail-open ({ pwned: false, count: 0 })', async () => {
    mockFetchResponse('Internal Error', false, 500);
    const result = await isPasswordPwned('whatever');
    expect(result).toEqual({ pwned: false, count: 0 });
  });

  it('fetch 例外 (network error) も fail-open', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network'));
    const result = await isPasswordPwned('whatever');
    expect(result).toEqual({ pwned: false, count: 0 });
  });
});

describe('SKIP_HIBP 環境変数', () => {
  it('SKIP_HIBP=true で外部呼出を skip', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SKIP_HIBP', 'true');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await isPasswordPwned('any-password');
    expect(result).toEqual({ pwned: false, count: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('assertPasswordNotPwned', () => {
  it('pwned=false の場合は resolve (テスト環境)', async () => {
    await expect(assertPasswordNotPwned('any-password')).resolves.toBeUndefined();
  });

  it('pwned=true の場合は PwnedPasswordError を throw', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SKIP_HIBP', 'false');
    const password = 'leaked!';
    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const suffix = sha1.slice(5);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(`${suffix}:99\n`, { status: 200 }) as never,
    );

    try {
      await assertPasswordNotPwned(password);
      // ここに到達したら fail
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(PwnedPasswordError);
      expect((e as PwnedPasswordError).pwnedCount).toBe(99);
    }
  });
});
