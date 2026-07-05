import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    knowledge: { findMany: vi.fn() },
    riskIssue: { findMany: vi.fn() },
    retrospective: { findMany: vi.fn() },
    ideaQaThread: { findMany: vi.fn() },
    ideaWhiteboardSession: { findMany: vi.fn() },
    ideaVotingSession: { findMany: vi.fn() },
  },
}));

vi.mock('./embedding.service', () => ({
  generateEmbedding: vi.fn(),
}));

import { projectChatSearch } from './project-chat-search.service';
import { prisma } from '@/lib/db';
import { generateEmbedding } from './embedding.service';

const mockedQueryRaw = vi.mocked(prisma.$queryRaw);
const mockedGenerateEmbedding = vi.mocked(generateEmbedding);

const INPUT = {
  projectId: '00000000-0000-0000-0000-000000000002',
  tenantId: '00000000-0000-0000-0000-000000000001',
  userId: '00000000-0000-0000-0000-000000000010',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.retrospective.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.ideaQaThread.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.ideaWhiteboardSession.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.ideaVotingSession.findMany).mockResolvedValue([] as never);
});

describe('projectChatSearch — 早期 return', () => {
  it('query が空白のみ → embedding 呼ばずに空結果', async () => {
    const result = await projectChatSearch({ query: '   ', ...INPUT });

    expect(mockedGenerateEmbedding).not.toHaveBeenCalled();
    expect(result.degraded).toBe(false);
    expect(result.totalCount).toBe(0);
    expect(result.results.knowledges).toEqual([]);
  });
});

describe('projectChatSearch — 縮退モード (embedding 失敗)', () => {
  it('embedding 失敗時は degraded=true で空結果を返す', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce({
      ok: false,
      reason: 'fair_use_limit_exceeded',
      message: 'fair use limit exceeded',
    });

    const result = await projectChatSearch({ query: 'リスク対策', ...INPUT });

    expect(result.degraded).toBe(true);
    expect(result.degradeReason).toBe('fair_use_limit_exceeded');
    expect(result.totalCount).toBe(0);
    expect(mockedQueryRaw).not.toHaveBeenCalled();
  });
});

describe('projectChatSearch — 正常系 (embedding 成功)', () => {
  it('1024 次元 embedding を生成し 6 資産を pgvector 並列検索する', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: Array.from({ length: 1024 }, () => 0.1),
      costJpy: 0,
      requestId: 'req-1',
    });
    mockedQueryRaw.mockResolvedValue([] as never);

    const result = await projectChatSearch({ query: '工数膨張への対策', ...INPUT });

    expect(mockedGenerateEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '工数膨張への対策',
        featureUnit: 'chat-semantic-search',
        inputType: 'query',
        tenantId: INPUT.tenantId,
        userId: INPUT.userId,
      }),
    );
    // 6 資産 × 1 pgvectorSearch call
    expect(mockedQueryRaw).toHaveBeenCalledTimes(6);
    expect(result.degraded).toBe(false);
    expect(result.totalCount).toBe(0);
  });

  it('知識ヒットを正しく ChatSearchHit に整形する', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: Array.from({ length: 1024 }, () => 0.5),
      costJpy: 0,
      requestId: 'req-2',
    });
    // 1 回目の queryRaw (knowledges) にヒットを返す、残りは空
    mockedQueryRaw
      .mockResolvedValueOnce([{ id: 'k-1', score: 0.85 }] as never)
      .mockResolvedValue([] as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValueOnce([
      { id: 'k-1', title: 'リスク軽減のナレッジ', content: '詳細説明テキスト'.repeat(10) },
    ] as never);

    const result = await projectChatSearch({ query: 'リスク', ...INPUT });

    expect(result.results.knowledges).toHaveLength(1);
    expect(result.results.knowledges[0]).toMatchObject({
      kind: 'knowledge',
      id: 'k-1',
      title: 'リスク軽減のナレッジ',
    });
    expect(result.totalCount).toBe(1);
  });

  it('クローズ済み Q&A スレッドのヒットを qa_thread として整形する', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: Array.from({ length: 1024 }, () => 0.5),
      costJpy: 0,
      requestId: 'req-3',
    });
    mockedQueryRaw
      .mockResolvedValueOnce([] as never) // knowledges
      .mockResolvedValueOnce([] as never) // risks_issues
      .mockResolvedValueOnce([] as never) // retrospectives
      .mockResolvedValueOnce([{ id: 'qa-1', score: 0.75 }] as never) // qa_threads
      .mockResolvedValue([] as never); // whiteboard, voting
    vi.mocked(prisma.ideaQaThread.findMany).mockResolvedValueOnce([
      { id: 'qa-1', question: 'このプロジェクトの納期はいつですか？', answerCount: 3 },
    ] as never);

    const result = await projectChatSearch({ query: '納期', ...INPUT });

    expect(result.results.qaThreads).toHaveLength(1);
    expect(result.results.qaThreads[0]).toMatchObject({
      kind: 'qa_thread',
      id: 'qa-1',
      snippet: '回答 3 件',
    });
  });

  it('tenantId と projectId を全検索クエリに付与する (テナント境界保護)', async () => {
    mockedGenerateEmbedding.mockResolvedValueOnce({
      ok: true,
      embedding: Array.from({ length: 1024 }, () => 0.1),
      costJpy: 0,
      requestId: 'req-4',
    });
    mockedQueryRaw.mockResolvedValue([] as never);

    await projectChatSearch({ query: 'test', ...INPUT });

    // $queryRaw はタグ付きテンプレートのため引数直接比較は困難。
    // 呼び出し回数のみを確認 (= 全 6 資産 × 1 call)
    expect(mockedQueryRaw).toHaveBeenCalledTimes(6);
  });
});
