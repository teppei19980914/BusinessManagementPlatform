import { describe, it, expect, vi } from 'vitest';
import {
  buildUrl,
  computeBackoffMs,
  fetchJson,
  collectByCursor,
  collectByOffset,
  ConnectorHttpError,
  type FetchLike,
} from './http';

/** Response 風モック (headers は Headers で持つ)。 */
function mockRes(opts: {
  status: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}): Response {
  const headers = new Headers(opts.headers ?? {});
  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    headers,
    json: async () => opts.json,
    text: async () => opts.text ?? '',
  } as unknown as Response;
}

describe('buildUrl', () => {
  it('undefined のクエリを除外し encode する', () => {
    expect(buildUrl('https://x/api', { a: '1 2', b: undefined, c: 3 })).toBe(
      'https://x/api?a=1%202&c=3',
    );
  });
  it('既に ? を含む URL は & で連結', () => {
    expect(buildUrl('https://x/api?z=0', { a: 1 })).toBe('https://x/api?z=0&a=1');
  });
  it('クエリなしは素通し', () => {
    expect(buildUrl('https://x/api')).toBe('https://x/api');
  });
});

describe('computeBackoffMs', () => {
  const now = () => 1_000_000; // 固定時刻 (ms)

  it('Retry-After 秒整数を優先 (ms 換算)', () => {
    const res = mockRes({ status: 429, headers: { 'retry-after': '3' } });
    expect(computeBackoffMs(res, 0, { now })).toBe(3000);
  });

  it('Retry-After が HTTP-date なら差分 ms', () => {
    const future = new Date(now() + 5000).toUTCString();
    const res = mockRes({ status: 429, headers: { 'retry-after': future } });
    // toUTCString は秒精度のため誤差を許容
    expect(computeBackoffMs(res, 0, { now })).toBeGreaterThanOrEqual(4000);
    expect(computeBackoffMs(res, 0, { now })).toBeLessThanOrEqual(5000);
  });

  it('X-RateLimit-Reset (Unix秒) を 2 番手で使う', () => {
    const resetSec = now() / 1000 + 4; // 4 秒後
    const res = mockRes({ status: 429, headers: { 'x-ratelimit-reset': String(resetSec) } });
    expect(computeBackoffMs(res, 0, { now })).toBe(4000);
  });

  it('ヘッダなしは指数バックオフ base*2^attempt', () => {
    const res = mockRes({ status: 500 });
    expect(computeBackoffMs(res, 0, { now, baseDelayMs: 500 })).toBe(500);
    expect(computeBackoffMs(res, 3, { now, baseDelayMs: 500 })).toBe(4000);
  });

  it('maxDelay で頭打ち', () => {
    const res = mockRes({ status: 429, headers: { 'retry-after': '9999' } });
    expect(computeBackoffMs(res, 0, { now, maxDelayMs: 60_000 })).toBe(60_000);
  });
});

describe('fetchJson', () => {
  const sleep = vi.fn(async () => {}); // 待機は即時化

  it('200 は JSON を返す', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => mockRes({ status: 200, json: { ok: 1 } }));
    const out = await fetchJson<{ ok: number }>({ url: 'https://x' }, { fetchImpl, sleep });
    expect(out).toEqual({ ok: 1 });
  });

  it('429 を 1 回挟んでも再試行して成功する', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(mockRes({ status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(mockRes({ status: 200, json: { v: 'ok' } }));
    const out = await fetchJson<{ v: string }>({ url: 'https://x' }, { fetchImpl, sleep });
    expect(out).toEqual({ v: 'ok' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('404 は再試行せず ConnectorHttpError', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      mockRes({ status: 404, text: 'not found' }),
    );
    await expect(fetchJson({ url: 'https://x' }, { fetchImpl, sleep })).rejects.toBeInstanceOf(
      ConnectorHttpError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maxRetries 到達で最後のエラーを投げる', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => mockRes({ status: 503, text: 'busy' }));
    await expect(
      fetchJson({ url: 'https://x' }, { fetchImpl, sleep, maxRetries: 2 }),
    ).rejects.toMatchObject({ status: 503 });
    // 初回 + 再試行 2 = 3
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('POST は JSON ボディと Content-Type を付ける', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => mockRes({ status: 200, json: {} }));
    await fetchJson({ url: 'https://x', method: 'POST', body: { a: 1 } }, { fetchImpl, sleep });
    const init = fetchImpl.mock.calls[0][1]!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });
});

describe('collectByCursor', () => {
  it('next が尽きるまで連結する', async () => {
    const pages: Record<string, { items: number[]; nextCursor?: string | null }> = {
      __start: { items: [1, 2], nextCursor: 'c1' },
      c1: { items: [3], nextCursor: 'c2' },
      c2: { items: [4, 5], nextCursor: null },
    };
    const all = await collectByCursor(async (cursor) => pages[cursor ?? '__start']);
    expect(all).toEqual([1, 2, 3, 4, 5]);
  });

  it('maxPages で打ち切る', async () => {
    const all = await collectByCursor(
      async () => ({ items: [1], nextCursor: 'always' }),
      { maxPages: 3 },
    );
    expect(all).toEqual([1, 1, 1]);
  });
});

describe('collectByOffset', () => {
  it('total 到達まで pageSize 刻みで取得', async () => {
    const data = [10, 11, 12, 13, 14];
    const all = await collectByOffset(
      async (offset) => ({ items: data.slice(offset, offset + 2), total: data.length }),
      2,
    );
    expect(all).toEqual(data);
  });

  it('空ページで停止 (total が過大でも無限ループしない)', async () => {
    const all = await collectByOffset(
      async (offset) => ({ items: offset === 0 ? [1] : [], total: 9999 }),
      1,
    );
    expect(all).toEqual([1]);
  });
});
