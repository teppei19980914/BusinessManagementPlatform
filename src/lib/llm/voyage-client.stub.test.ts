/**
 * E2E embedding スタブ provider の unit test (test/release-acceptance-e2e / 2026-06)。
 *
 * 検証:
 *   1. EMBEDDING_PROVIDER=stub (非 production) → 鍵なしでも EMBEDDING_DIMENSIONS 次元の
 *      finite な決定論的ベクトルを返す
 *   2. ★安全モデル★ EMBEDDING_PROVIDER 未設定なら stub は無効で、鍵なしは従来通り fail-closed
 *      (本番は本 env を設定しない = 既定で実 Voyage。NODE_ENV では分岐しない)
 */

import { describe, it, expect, afterEach } from 'vitest';

import { VoyageConfigError, voyageEmbed, isEmbeddingStubEnabled } from './voyage-client';
import { EMBEDDING_DIMENSIONS } from '@/config/llm';

const ORIGINAL_KEY = process.env.VOYAGE_API_KEY;
const ORIGINAL_PROVIDER = process.env.EMBEDDING_PROVIDER;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function setNodeEnv(value: string): void {
  (process.env as Record<string, string>).NODE_ENV = value;
}

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.VOYAGE_API_KEY;
  else process.env.VOYAGE_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_PROVIDER === undefined) delete process.env.EMBEDDING_PROVIDER;
  else process.env.EMBEDDING_PROVIDER = ORIGINAL_PROVIDER;
  setNodeEnv(ORIGINAL_NODE_ENV ?? 'test');
});

describe('embedding stub provider', () => {
  it('EMBEDDING_PROVIDER=stub (非 production) で鍵なしでも次元一致の finite ベクトルを返す', async () => {
    delete process.env.VOYAGE_API_KEY;
    process.env.EMBEDDING_PROVIDER = 'stub';
    setNodeEnv('test');

    expect(isEmbeddingStubEnabled()).toBe(true);

    const res = await voyageEmbed({ texts: ['たすきばのプロジェクト', '別のテキスト'] });
    expect(res.embeddings).toHaveLength(2);
    for (const vec of res.embeddings) {
      expect(vec).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(vec.every((n) => Number.isFinite(n))).toBe(true);
      expect(vec.every((n) => n >= -1 && n <= 1)).toBe(true);
    }
    expect(res.totalTokens).toBeGreaterThan(0);
  });

  it('同じ入力には同じベクトルを返す (決定論的 = flaky 回避)', async () => {
    delete process.env.VOYAGE_API_KEY;
    process.env.EMBEDDING_PROVIDER = 'stub';
    setNodeEnv('test');

    const a = await voyageEmbed({ texts: ['同一入力'] });
    const b = await voyageEmbed({ texts: ['同一入力'] });
    expect(a.embeddings[0]).toEqual(b.embeddings[0]);
  });

  it('EMBEDDING_PROVIDER 未設定なら stub 無効・鍵なしは VoyageConfigError (本番既定の挙動)', async () => {
    delete process.env.VOYAGE_API_KEY;
    delete process.env.EMBEDDING_PROVIDER;
    setNodeEnv('test');

    expect(isEmbeddingStubEnabled()).toBe(false);
    await expect(voyageEmbed({ texts: ['x'] })).rejects.toBeInstanceOf(VoyageConfigError);
  });

  it('★重要★ NODE_ENV=production でも EMBEDDING_PROVIDER=stub なら stub 有効 (E2E standalone 互換)', () => {
    process.env.EMBEDDING_PROVIDER = 'stub';
    setNodeEnv('production');
    expect(isEmbeddingStubEnabled()).toBe(true);
  });
});
