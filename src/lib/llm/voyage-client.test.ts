import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  VoyageApiError,
  VoyageConfigError,
  _setVoyageFetcherForTest,
  voyageEmbed,
} from './voyage-client';
import { EMBEDDING_DIMENSIONS } from '@/config/llm';

const ORIGINAL_KEY = process.env.VOYAGE_API_KEY;

beforeEach(() => {
  process.env.VOYAGE_API_KEY = 'test-voyage-key';
  _setVoyageFetcherForTest(null);
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.VOYAGE_API_KEY;
  } else {
    process.env.VOYAGE_API_KEY = ORIGINAL_KEY;
  }
  _setVoyageFetcherForTest(null);
});

function makeOkResponse(embeddings: number[][], totalTokens = 50): Response {
  return new Response(
    JSON.stringify({
      object: 'list',
      data: embeddings.map((e, i) => ({
        object: 'embedding',
        embedding: e,
        index: i,
      })),
      model: 'voyage-4-lite',
      usage: { total_tokens: totalTokens },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeFakeEmbedding(dim = EMBEDDING_DIMENSIONS): number[] {
  return new Array(dim).fill(0).map((_, i) => i / dim);
}

describe('voyageEmbed - 正常系', () => {
  it('単一テキストの embedding を取得', async () => {
    const fakeEmbedding = makeFakeEmbedding();
    const fetcher = vi
      .fn()
      .mockResolvedValue(makeOkResponse([fakeEmbedding], 100));
    _setVoyageFetcherForTest(fetcher as unknown as typeof globalThis.fetch);

    const result = await voyageEmbed({ texts: ['Hello world'] });

    expect(result.embeddings).toHaveLength(1);
    expect(result.embeddings[0]).toEqual(fakeEmbedding);
    expect(result.totalTokens).toBe(100);
  });

  it('複数テキストの embedding を一括取得', async () => {
    const e1 = makeFakeEmbedding();
    const e2 = makeFakeEmbedding();
    const fetcher = vi.fn().mockResolvedValue(makeOkResponse([e1, e2], 200));
    _setVoyageFetcherForTest(fetcher as unknown as typeof globalThis.fetch);

    const result = await voyageEmbed({ texts: ['t1', 't2'] });

    expect(result.embeddings).toHaveLength(2);
    expect(result.totalTokens).toBe(200);
  });

  it('リクエスト body に model = voyage-4-lite と output_dimension が含まれる', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(makeOkResponse([makeFakeEmbedding()]));
    _setVoyageFetcherForTest(fetcher as unknown as typeof globalThis.fetch);

    await voyageEmbed({ texts: ['x'] });

    const call = fetcher.mock.calls[0]!;
    expect(call[0]).toBe('https://api.voyageai.com/v1/embeddings');
    const body = JSON.parse(call[1].body as string);
    expect(body.model).toBe('voyage-4-lite');
    expect(body.output_dimension).toBe(EMBEDDING_DIMENSIONS);
    expect(body.input).toEqual(['x']);
  });

  it('Authorization: Bearer ヘッダが付く', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(makeOkResponse([makeFakeEmbedding()]));
    _setVoyageFetcherForTest(fetcher as unknown as typeof globalThis.fetch);

    await voyageEmbed({ texts: ['x'] });

    const call = fetcher.mock.calls[0]!;
    expect(call[1].headers.Authorization).toBe('Bearer test-voyage-key');
  });

  it('inputType を指定すると body に input_type が含まれる', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(makeOkResponse([makeFakeEmbedding()]));
    _setVoyageFetcherForTest(fetcher as unknown as typeof globalThis.fetch);

    await voyageEmbed({ texts: ['x'], inputType: 'query' });

    const body = JSON.parse(fetcher.mock.calls[0]![1].body as string);
    expect(body.input_type).toBe('query');
  });

  it('inputType 未指定時は body に input_type フィールドなし', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(makeOkResponse([makeFakeEmbedding()]));
    _setVoyageFetcherForTest(fetcher as unknown as typeof globalThis.fetch);

    await voyageEmbed({ texts: ['x'] });

    const body = JSON.parse(fetcher.mock.calls[0]![1].body as string);
    expect('input_type' in body).toBe(false);
  });
});

describe('voyageEmbed - 異常系 / 設定不備', () => {
  it('VOYAGE_API_KEY 未設定なら VoyageConfigError', async () => {
    delete process.env.VOYAGE_API_KEY;
    await expect(voyageEmbed({ texts: ['x'] })).rejects.toThrow(VoyageConfigError);
  });

  it('VOYAGE_API_KEY 空文字でも VoyageConfigError', async () => {
    process.env.VOYAGE_API_KEY = '';
    await expect(voyageEmbed({ texts: ['x'] })).rejects.toThrow(VoyageConfigError);
  });

  it('VOYAGE_API_KEY 空白のみでも VoyageConfigError', async () => {
    process.env.VOYAGE_API_KEY = '   ';
    await expect(voyageEmbed({ texts: ['x'] })).rejects.toThrow(VoyageConfigError);
  });
});

describe('voyageEmbed - HTTP エラー応答', () => {
  it('429 応答で VoyageApiError (status=429) を投げる', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('rate limit exceeded', { status: 429 }),
    );
    _setVoyageFetcherForTest(fetcher as unknown as typeof globalThis.fetch);

    try {
      await voyageEmbed({ texts: ['x'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(VoyageApiError);
      expect((err as VoyageApiError).status).toBe(429);
      expect((err as VoyageApiError).message).toContain('429');
    }
  });

  it('500 応答で VoyageApiError (status=500)', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('internal error', { status: 500 }),
    );
    _setVoyageFetcherForTest(fetcher as unknown as typeof globalThis.fetch);

    await expect(voyageEmbed({ texts: ['x'] })).rejects.toBeInstanceOf(VoyageApiError);
  });
});

describe('voyageEmbed - 出力検証', () => {
  it('embedding 次元が EMBEDDING_DIMENSIONS と異なる場合 throw', async () => {
    const wrongDim = new Array(512).fill(0); // 1024 ではなく 512
    const fetcher = vi.fn().mockResolvedValue(makeOkResponse([wrongDim]));
    _setVoyageFetcherForTest(fetcher as unknown as typeof globalThis.fetch);

    await expect(voyageEmbed({ texts: ['x'] })).rejects.toThrow(/length/);
  });

  it('スキーマ違反応答 (data 欠落) で zod が throw', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ unexpected: 'shape' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    _setVoyageFetcherForTest(fetcher as unknown as typeof globalThis.fetch);

    await expect(voyageEmbed({ texts: ['x'] })).rejects.toThrow();
  });
});

describe('VoyageConfigError / VoyageApiError', () => {
  it('VoyageConfigError は Error のサブクラス', () => {
    const e = new VoyageConfigError('msg');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(VoyageConfigError);
    expect(e.name).toBe('VoyageConfigError');
  });

  it('VoyageApiError は status を保持', () => {
    const e = new VoyageApiError(503, 'overloaded');
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(503);
    expect(e.name).toBe('VoyageApiError');
  });
});
