import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock('@/lib/llm/metered', () => ({
  withMeteredLLM: vi.fn(),
}));

vi.mock('@/lib/llm/voyage-client', () => ({
  voyageEmbed: vi.fn(),
}));

import {
  MAX_INPUT_CHARS,
  generateEmbedding,
  persistEmbedding,
  searchSimilar,
} from './embedding.service';
import { prisma } from '@/lib/db';
import { withMeteredLLM } from '@/lib/llm/metered';
import { voyageEmbed } from '@/lib/llm/voyage-client';
import { EMBEDDING_DIMENSIONS } from '@/config/llm';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const USER_ID = 'user-1';

function makeFakeEmbedding(dim = EMBEDDING_DIMENSIONS): number[] {
  return new Array(dim).fill(0).map((_, i) => i / dim);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateEmbedding - 正常系', () => {
  it('voyageEmbed の戻り値を embedding として返す', async () => {
    const fakeEmbedding = makeFakeEmbedding();
    vi.mocked(withMeteredLLM).mockImplementation(async (_opts, call) => {
      vi.mocked(voyageEmbed).mockResolvedValue({
        embeddings: [fakeEmbedding],
        totalTokens: 100,
      });
      const r = await call({ modelName: 'voyage-4-lite', requestId: 'req-1' });
      return {
        ok: true,
        result: r.result,
        costJpy: 0,
        latencyMs: 50,
        modelName: 'voyage-4-lite',
        requestId: 'req-1',
      };
    });

    const result = await generateEmbedding({
      text: 'EC サイト構築プロジェクト',
      featureUnit: 'project-embedding',
      tenantId: TENANT_A,
      userId: USER_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.embedding).toEqual(fakeEmbedding);
      expect(result.requestId).toBe('req-1');
    }
  });

  it('withMeteredLLM に featureUnit / tenantId / userId が渡る', async () => {
    vi.mocked(withMeteredLLM).mockImplementation(async (_opts, call) => {
      vi.mocked(voyageEmbed).mockResolvedValue({
        embeddings: [makeFakeEmbedding()],
        totalTokens: 100,
      });
      const r = await call({ modelName: 'voyage-4-lite', requestId: 'req-1' });
      return {
        ok: true,
        result: r.result,
        costJpy: 0,
        latencyMs: 1,
        modelName: 'voyage-4-lite',
        requestId: 'req-1',
      };
    });

    await generateEmbedding({
      text: 'x',
      featureUnit: 'project-embedding',
      tenantId: TENANT_A,
      userId: USER_ID,
    });

    const opts = vi.mocked(withMeteredLLM).mock.calls[0]![0];
    expect(opts.featureUnit).toBe('project-embedding');
    expect(opts.tenantId).toBe(TENANT_A);
    expect(opts.userId).toBe(USER_ID);
  });

  it('inputType を伝播する (default は document)', async () => {
    vi.mocked(withMeteredLLM).mockImplementation(async (_opts, call) => {
      vi.mocked(voyageEmbed).mockResolvedValue({
        embeddings: [makeFakeEmbedding()],
        totalTokens: 100,
      });
      await call({ modelName: 'voyage-4-lite', requestId: 'req-1' });
      return {
        ok: true,
        result: makeFakeEmbedding(),
        costJpy: 0,
        latencyMs: 1,
        modelName: 'voyage-4-lite',
        requestId: 'req-1',
      };
    });

    await generateEmbedding({
      text: 'x',
      featureUnit: 'project-embedding',
      tenantId: TENANT_A,
      inputType: 'query',
    });

    expect(voyageEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ inputType: 'query' }),
    );
  });

  it('inputType 未指定時は document が使われる', async () => {
    vi.mocked(withMeteredLLM).mockImplementation(async (_opts, call) => {
      vi.mocked(voyageEmbed).mockResolvedValue({
        embeddings: [makeFakeEmbedding()],
        totalTokens: 100,
      });
      await call({ modelName: 'voyage-4-lite', requestId: 'req-1' });
      return {
        ok: true,
        result: makeFakeEmbedding(),
        costJpy: 0,
        latencyMs: 1,
        modelName: 'voyage-4-lite',
        requestId: 'req-1',
      };
    });

    await generateEmbedding({
      text: 'x',
      featureUnit: 'project-embedding',
      tenantId: TENANT_A,
    });

    expect(voyageEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ inputType: 'document' }),
    );
  });
});

describe('generateEmbedding - 入力 sanitize', () => {
  it(`${MAX_INPUT_CHARS} 文字超は truncate される`, async () => {
    let capturedText = '';
    vi.mocked(withMeteredLLM).mockImplementation(async (_opts, call) => {
      vi.mocked(voyageEmbed).mockImplementation(async ({ texts }) => {
        capturedText = texts[0]!;
        return { embeddings: [makeFakeEmbedding()], totalTokens: 1 };
      });
      await call({ modelName: 'voyage-4-lite', requestId: 'req-1' });
      return {
        ok: true,
        result: makeFakeEmbedding(),
        costJpy: 0,
        latencyMs: 1,
        modelName: 'voyage-4-lite',
        requestId: 'req-1',
      };
    });

    const longText = 'あ'.repeat(MAX_INPUT_CHARS + 500);
    await generateEmbedding({
      text: longText,
      featureUnit: 'project-embedding',
      tenantId: TENANT_A,
    });

    expect(capturedText.length).toBe(MAX_INPUT_CHARS);
  });

  it('空文字は LLM 呼び出さず output_invalid を返す', async () => {
    const result = await generateEmbedding({
      text: '',
      featureUnit: 'project-embedding',
      tenantId: TENANT_A,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('output_invalid');
    expect(withMeteredLLM).not.toHaveBeenCalled();
  });

  it('空白のみも LLM 呼び出さず output_invalid', async () => {
    const result = await generateEmbedding({
      text: '   \n\t   ',
      featureUnit: 'project-embedding',
      tenantId: TENANT_A,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('output_invalid');
    expect(withMeteredLLM).not.toHaveBeenCalled();
  });
});

describe('generateEmbedding - 縮退伝播 / 失敗', () => {
  it('rate_limited をそのまま返す', async () => {
    vi.mocked(withMeteredLLM).mockResolvedValue({
      ok: false,
      reason: 'rate_limited',
      retryAfterSec: 30,
      message: 'rate',
    });

    const result = await generateEmbedding({
      text: 'x',
      featureUnit: 'project-embedding',
      tenantId: TENANT_A,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('rate_limited');
  });

  it('budget_exceeded をそのまま返す', async () => {
    vi.mocked(withMeteredLLM).mockResolvedValue({
      ok: false,
      reason: 'budget_exceeded',
      message: 'budget',
    });

    const result = await generateEmbedding({
      text: 'x',
      featureUnit: 'project-embedding',
      tenantId: TENANT_A,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('budget_exceeded');
  });

  it('llm_error (Voyage 内部エラー) をそのまま返す', async () => {
    vi.mocked(withMeteredLLM).mockResolvedValue({
      ok: false,
      reason: 'llm_error',
      error: new Error('5xx'),
      message: '5xx',
    });

    const result = await generateEmbedding({
      text: 'x',
      featureUnit: 'project-embedding',
      tenantId: TENANT_A,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('llm_error');
  });

  it('embedding 次元が想定外なら output_invalid', async () => {
    vi.mocked(withMeteredLLM).mockImplementation(async (_opts, call) => {
      vi.mocked(voyageEmbed).mockResolvedValue({
        embeddings: [new Array(512).fill(0)],
        totalTokens: 1,
      });
      try {
        await call({ modelName: 'voyage-4-lite', requestId: 'req-1' });
      } catch {
        // voyage-client が次元異常時に throw する。withMeteredLLM が llm_error 化
      }
      return {
        ok: true,
        result: new Array(512).fill(0), // wrong dim
        costJpy: 0,
        latencyMs: 1,
        modelName: 'voyage-4-lite',
        requestId: 'req-1',
      };
    });

    const result = await generateEmbedding({
      text: 'x',
      featureUnit: 'project-embedding',
      tenantId: TENANT_A,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('output_invalid');
  });
});

describe('persistEmbedding', () => {
  it('white-list 外のテーブル名は throw', async () => {
    await expect(
      persistEmbedding(
        // @ts-expect-error: invalid table for testing
        'evil_table',
        'r1',
        TENANT_A,
        makeFakeEmbedding(),
      ),
    ).rejects.toThrow(/Invalid table/);
  });

  it('embedding 次元が異常なら throw', async () => {
    await expect(
      persistEmbedding('projects', 'r1', TENANT_A, [1, 2, 3]),
    ).rejects.toThrow(/length/);
  });

  it('正常時は $executeRawUnsafe を呼び、テナント境界 + cast を含む SQL', async () => {
    vi.mocked(prisma.$executeRawUnsafe).mockResolvedValue(1);
    const e = makeFakeEmbedding();

    const updated = await persistEmbedding('projects', 'r1', TENANT_A, e);

    expect(updated).toBe(1);
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, vectorText, rowId, tenantId] = vi.mocked(prisma.$executeRawUnsafe).mock.calls[0]!;
    expect(sql).toContain('UPDATE "projects"');
    expect(sql).toContain('content_embedding');
    expect(sql).toContain('$1::vector');
    expect(sql).toContain('tenant_id = $3::uuid');
    expect(typeof vectorText).toBe('string');
    expect(vectorText as string).toMatch(/^\[.*\]$/); // pgvector text 形式
    expect(rowId).toBe('r1');
    expect(tenantId).toBe(TENANT_A);
  });
});

describe('searchSimilar', () => {
  it('white-list 外のテーブル名は throw', async () => {
    await expect(
      searchSimilar({
        // @ts-expect-error: invalid table for testing
        table: 'evil',
        queryEmbedding: makeFakeEmbedding(),
        tenantId: TENANT_A,
      }),
    ).rejects.toThrow(/Invalid table/);
  });

  it('queryEmbedding 次元が想定外なら throw', async () => {
    await expect(
      searchSimilar({
        table: 'projects',
        queryEmbedding: [1, 2, 3],
        tenantId: TENANT_A,
      }),
    ).rejects.toThrow(/length/);
  });

  it('SQL に tenant_id / deleted_at / content_embedding IS NOT NULL の境界条件が含まれる', async () => {
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([]);

    await searchSimilar({
      table: 'knowledges',
      queryEmbedding: makeFakeEmbedding(),
      tenantId: TENANT_A,
    });

    const [sql] = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0]!;
    expect(sql).toContain('FROM "knowledges"');
    expect(sql).toContain('tenant_id'); // tenantId 境界
    expect(sql).toContain('"deleted_at" IS NULL'); // soft-delete フィルタ
    expect(sql).toContain('"content_embedding" IS NOT NULL'); // NULL 除外
    expect(sql).toContain('<=>'); // cosine distance 演算子
  });

  it('結果を score 降順で返却 (cosine_distance を score に変換)', async () => {
    // pgvector の <=> は 0=同一 / 2=正反対。score は 1 - distance/2 で 1.0=同一
    // モックは事前に変換後の score を返す体裁
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([
      { id: 'k1', score: 0.95 },
      { id: 'k2', score: 0.7 },
      { id: 'k3', score: 0.3 },
    ]);

    const results = await searchSimilar({
      table: 'knowledges',
      queryEmbedding: makeFakeEmbedding(),
      tenantId: TENANT_A,
    });

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ id: 'k1', score: 0.95 });
    expect(results[2]).toEqual({ id: 'k3', score: 0.3 });
  });

  it('minScore で下限フィルタ', async () => {
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([
      { id: 'k1', score: 0.95 },
      { id: 'k2', score: 0.7 },
      { id: 'k3', score: 0.3 },
    ]);

    const results = await searchSimilar({
      table: 'knowledges',
      queryEmbedding: makeFakeEmbedding(),
      tenantId: TENANT_A,
      minScore: 0.5,
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.score >= 0.5)).toBe(true);
  });

  it('excludeIds 指定時は SQL に id <> ALL($4) 句が追加され、4 引数で渡される', async () => {
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([]);

    await searchSimilar({
      table: 'projects',
      queryEmbedding: makeFakeEmbedding(),
      tenantId: TENANT_A,
      excludeIds: ['p-self'],
    });

    const args = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0]!;
    const sql = args[0] as string;
    expect(sql).toContain('id <> ALL($4::uuid[])');
    // bind 値は順に: vectorText, tenantId, limit, excludeIds
    expect(args).toHaveLength(5); // sql + 4 params
    expect(args[4]).toEqual(['p-self']);
  });

  it('excludeIds なしなら SQL に <> ALL は含まれず、3 引数で渡される', async () => {
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([]);

    await searchSimilar({
      table: 'projects',
      queryEmbedding: makeFakeEmbedding(),
      tenantId: TENANT_A,
    });

    const args = vi.mocked(prisma.$queryRawUnsafe).mock.calls[0]!;
    const sql = args[0] as string;
    expect(sql).not.toContain('<> ALL');
    expect(args).toHaveLength(4); // sql + 3 params
  });
});
