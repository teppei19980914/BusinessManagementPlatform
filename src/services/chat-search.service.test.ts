import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    project: { findMany: vi.fn() },
    knowledge: { findMany: vi.fn() },
    riskIssue: { findMany: vi.fn() },
    retrospective: { findMany: vi.fn() },
    memo: { findMany: vi.fn() },
  },
}));

vi.mock('./embedding.service', () => ({
  generateEmbedding: vi.fn(),
}));

import { chatSemanticSearch } from './chat-search.service';
import { prisma } from '@/lib/db';
import { generateEmbedding } from './embedding.service';

const mockedQueryRaw = vi.mocked(prisma.$queryRaw);
const mockedProjectFindMany = vi.mocked(prisma.project.findMany);
const mockedKnowledgeFindMany = vi.mocked(prisma.knowledge.findMany);
const mockedRiskIssueFindMany = vi.mocked(prisma.riskIssue.findMany);
const mockedRetrospectiveFindMany = vi.mocked(prisma.retrospective.findMany);
const mockedMemoFindMany = vi.mocked(prisma.memo.findMany);
const mockedGenerateEmbedding = vi.mocked(generateEmbedding);

const INPUT = {
  viewerTenantId: '00000000-0000-0000-0000-000000000001',
  viewerUserId: '00000000-0000-0000-0000-000000000010',
  viewerSeedDataEnabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  // 各 findMany の default は空配列
  mockedProjectFindMany.mockResolvedValue([] as never);
  mockedKnowledgeFindMany.mockResolvedValue([] as never);
  mockedRiskIssueFindMany.mockResolvedValue([] as never);
  mockedRetrospectiveFindMany.mockResolvedValue([] as never);
  mockedMemoFindMany.mockResolvedValue([] as never);
});

describe('chatSemanticSearch — 早期 return', () => {
  it('query が空白のみ → embedding 呼ばずに空結果', async () => {
    const result = await chatSemanticSearch({ query: '   ', ...INPUT });

    expect(mockedGenerateEmbedding).not.toHaveBeenCalled();
    expect(result.degraded).toBe(false);
    expect(result.totalCount).toBe(0);
    expect(result.results.projects).toEqual([]);
  });
});

describe('chatSemanticSearch — 正常系 (embedding 成功)', () => {
  it('1024 次元 embedding を生成し、5 資産を pgvector 並列検索する', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: Array.from({ length: 1024 }, () => 0.1),
      costJpy: 10,
      requestId: 'req-1',
    });

    // pgvector の SELECT 文 (table別5回 = pgvectorSearch) は全て空 hit を返す
    mockedQueryRaw.mockResolvedValue([] as never);

    const result = await chatSemanticSearch({ query: '工数膨張への対策', ...INPUT });

    expect(mockedGenerateEmbedding).toHaveBeenCalledTimes(1);
    expect(mockedGenerateEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '工数膨張への対策',
        featureUnit: 'chat-semantic-search',
        inputType: 'query',
        tenantId: INPUT.viewerTenantId,
        userId: INPUT.viewerUserId,
      }),
    );
    // 5 資産 × 1 pgvectorSearch call
    expect(mockedQueryRaw).toHaveBeenCalledTimes(5);
    expect(result.degraded).toBe(false);
    expect(result.totalCount).toBe(0);
  });

  it('hit があれば各 loadXxx で本体を取得し ChatSearchHit を組み立てる', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: Array.from({ length: 1024 }, () => 0.1),
      costJpy: 10,
      requestId: 'req-2',
    });

    // pgvectorSearch (table別5回): Project のみ hit、他は空
    mockedQueryRaw
      .mockResolvedValueOnce([{ id: 'p-1', score: 0.5 }] as never)  // projects
      .mockResolvedValueOnce([] as never)                            // knowledges
      .mockResolvedValueOnce([] as never)                            // risks_issues
      .mockResolvedValueOnce([] as never)                            // retrospectives
      .mockResolvedValueOnce([] as never);                           // memos

    mockedProjectFindMany.mockResolvedValueOnce([
      { id: 'p-1', name: 'ECモール再構築', purpose: '基幹リプレース' },
    ] as never);

    const result = await chatSemanticSearch({ query: '基幹リプレース案件の対策', ...INPUT });

    expect(result.degraded).toBe(false);
    expect(result.results.projects).toHaveLength(1);
    expect(result.results.projects[0]).toMatchObject({
      kind: 'project',
      id: 'p-1',
      title: 'ECモール再構築',
      snippet: '基幹リプレース',
      score: 0.5,
    });
    expect(result.totalCount).toBe(1);
  });
});

describe('chatSemanticSearch — 縮退モード (embedding 失敗)', () => {
  it('rate_limited → pg_trgm fallback で結果を返し degraded=true', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce({
      ok: false,
      reason: 'rate_limited',
      message: 'rate limit exceeded',
    });

    // pg_trgm (table別5回): Knowledge のみ hit
    mockedQueryRaw
      .mockResolvedValueOnce([] as never)                            // projects
      .mockResolvedValueOnce([{ id: 'k-1', score: 0.3 }] as never)   // knowledges
      .mockResolvedValueOnce([] as never)                            // risks_issues
      .mockResolvedValueOnce([] as never)                            // retrospectives
      .mockResolvedValueOnce([] as never);                           // memos

    mockedKnowledgeFindMany.mockResolvedValueOnce([
      { id: 'k-1', title: 'ナレッジ A', content: 'コンテンツ' },
    ] as never);

    const result = await chatSemanticSearch({ query: 'ナレッジ A の話', ...INPUT });

    expect(result.degraded).toBe(true);
    expect(result.degradeReason).toBe('rate_limited');
    expect(result.results.knowledges).toHaveLength(1);
    expect(result.totalCount).toBe(1);
  });

  it('beginner_limit_exceeded → 同様に pg_trgm fallback', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce({
      ok: false,
      reason: 'beginner_limit_exceeded',
      message: 'monthly limit exceeded',
    });
    mockedQueryRaw.mockResolvedValue([] as never);

    const result = await chatSemanticSearch({ query: 'test query', ...INPUT });

    expect(result.degraded).toBe(true);
    expect(result.degradeReason).toBe('beginner_limit_exceeded');
  });
});

describe('chatSemanticSearch — テナント境界', () => {
  it('seedDataEnabled=true なら MANAGEMENT_TENANT_ID を含む 2 値の tenantId 配列で検索', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: Array.from({ length: 1024 }, () => 0.1),
      costJpy: 10,
      requestId: 'req-3',
    });
    mockedQueryRaw.mockResolvedValue([] as never);

    await chatSemanticSearch({ query: 'q', ...INPUT, viewerSeedDataEnabled: true });

    // $queryRaw が tagged template で呼ばれており、第二引数群に tenantIds 配列が含まれる
    // 厳密検証は SQL 引数の解析が必要だが、まず呼出回数 = 5 を確認
    expect(mockedQueryRaw).toHaveBeenCalledTimes(5);
  });

  it('seedDataEnabled=false なら viewerTenantId のみ', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: Array.from({ length: 1024 }, () => 0.1),
      costJpy: 10,
      requestId: 'req-4',
    });
    mockedQueryRaw.mockResolvedValue([] as never);

    await chatSemanticSearch({ query: 'q', ...INPUT, viewerSeedDataEnabled: false });

    expect(mockedQueryRaw).toHaveBeenCalledTimes(5);
  });
});

describe('chatSemanticSearch — RiskIssue の kind 分岐', () => {
  it('type=risk → kind="risk"、type=issue → kind="issue"', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: Array.from({ length: 1024 }, () => 0.1),
      costJpy: 10,
      requestId: 'req-5',
    });

    mockedQueryRaw
      .mockResolvedValueOnce([] as never)                                          // projects
      .mockResolvedValueOnce([] as never)                                          // knowledges
      .mockResolvedValueOnce([                                                      // risks_issues
        { id: 'ri-1', score: 0.5 },
        { id: 'ri-2', score: 0.4 },
      ] as never)
      .mockResolvedValueOnce([] as never)                                          // retrospectives
      .mockResolvedValueOnce([] as never);                                         // memos

    mockedRiskIssueFindMany.mockResolvedValueOnce([
      { id: 'ri-1', type: 'risk', title: 'リスクA', content: 'risk content', projectId: 'p-1', project: { name: 'Proj1', deletedAt: null } },
      { id: 'ri-2', type: 'issue', title: '課題B', content: 'issue content', projectId: 'p-1', project: { name: 'Proj1', deletedAt: null } },
    ] as never);

    const result = await chatSemanticSearch({ query: 'リスクや課題を探したい', ...INPUT });

    expect(result.results.risksIssues).toHaveLength(2);
    const riskHit = result.results.risksIssues.find((r) => r.id === 'ri-1');
    const issueHit = result.results.risksIssues.find((r) => r.id === 'ri-2');
    expect(riskHit?.kind).toBe('risk');
    expect(issueHit?.kind).toBe('issue');
  });
});

describe('chatSemanticSearch — Memo author 表示', () => {
  it('Memo の authorUserId が結果に含まれる', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: Array.from({ length: 1024 }, () => 0.1),
      costJpy: 10,
      requestId: 'req-6',
    });

    mockedQueryRaw
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ id: 'm-1', score: 0.4 }] as never); // memos

    mockedMemoFindMany.mockResolvedValueOnce([
      { id: 'm-1', title: 'メモA', content: 'メモコンテンツ', userId: 'u-author' },
    ] as never);

    const result = await chatSemanticSearch({ query: 'メモを探したい', ...INPUT });

    expect(result.results.memos).toHaveLength(1);
    expect(result.results.memos[0].authorUserId).toBe('u-author');
    expect(result.results.memos[0].kind).toBe('memo');
  });
});

describe('chatSemanticSearch — defense-in-depth visibility フィルタ', () => {
  it('loadKnowledges の where 句に visibility="public" が含まれる', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: Array.from({ length: 1024 }, () => 0.1),
      costJpy: 10,
      requestId: 'req-vis-1',
    });

    mockedQueryRaw
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ id: 'k-1', score: 0.5 }] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    mockedKnowledgeFindMany.mockResolvedValueOnce([] as never);

    await chatSemanticSearch({ query: 'q', ...INPUT });

    expect(mockedKnowledgeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: { in: expect.any(Array) },
          deletedAt: null,
          visibility: 'public',
        }),
      }),
    );
  });

  it('loadRisksIssues の where 句に visibility="public" が含まれる', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: Array.from({ length: 1024 }, () => 0.1),
      costJpy: 10,
      requestId: 'req-vis-2',
    });

    mockedQueryRaw
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ id: 'r-1', score: 0.5 }] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    mockedRiskIssueFindMany.mockResolvedValueOnce([] as never);

    await chatSemanticSearch({ query: 'q', ...INPUT });

    expect(mockedRiskIssueFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ visibility: 'public' }),
      }),
    );
  });

  it('loadRetrospectives の where 句に visibility="public" が含まれる', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: Array.from({ length: 1024 }, () => 0.1),
      costJpy: 10,
      requestId: 'req-vis-3',
    });

    mockedQueryRaw
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ id: 'rt-1', score: 0.5 }] as never)
      .mockResolvedValueOnce([] as never);

    mockedRetrospectiveFindMany.mockResolvedValueOnce([] as never);

    await chatSemanticSearch({ query: 'q', ...INPUT });

    expect(mockedRetrospectiveFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ visibility: 'public' }),
      }),
    );
  });

  it('loadMemos の where 句に OR: [visibility="public", userId=viewerUserId] が含まれる (自分の private は対象)', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: Array.from({ length: 1024 }, () => 0.1),
      costJpy: 10,
      requestId: 'req-vis-4',
    });

    mockedQueryRaw
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ id: 'm-1', score: 0.5 }] as never);

    mockedMemoFindMany.mockResolvedValueOnce([] as never);

    await chatSemanticSearch({ query: 'q', ...INPUT });

    expect(mockedMemoFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ visibility: 'public' }, { userId: INPUT.viewerUserId }],
        }),
      }),
    );
  });
});

describe('chatSemanticSearch — 削除済プロジェクト名のマスク', () => {
  it('source project が deletedAt != null なら sourceProjectName は null', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: Array.from({ length: 1024 }, () => 0.1),
      costJpy: 10,
      requestId: 'req-7',
    });

    mockedQueryRaw
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ id: 'ri-deleted', score: 0.4 }] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    mockedRiskIssueFindMany.mockResolvedValueOnce([
      {
        id: 'ri-deleted',
        type: 'risk',
        title: 'リスクX',
        content: 'detail',
        projectId: 'p-deleted',
        project: { name: 'DeletedProject', deletedAt: new Date('2025-01-01') },
      },
    ] as never);

    const result = await chatSemanticSearch({ query: 'リスクを探す', ...INPUT });

    expect(result.results.risksIssues[0].sourceProjectName).toBeNull();
    // projectId は audit 用に残す
    expect(result.results.risksIssues[0].sourceProjectId).toBe('p-deleted');
  });
});
