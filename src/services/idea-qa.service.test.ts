import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    ideaQaThread: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    ideaQaAnswer: {
      create: vi.fn(),
    },
    ideaQaUpvote: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    ideaAssetLink: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
    $executeRaw: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('@/services/embedding.service', () => ({
  generateEmbedding: vi.fn(),
}));

import {
  listQaThreads,
  getQaThread,
  createQaThread,
  closeQaThread,
  createAnswer,
  toggleUpvote,
  deleteQaThread,
} from './idea-qa.service';
import { prisma } from '@/lib/db';
import { generateEmbedding } from '@/services/embedding.service';

const T = '00000000-0000-0000-0000-000000000001';
const P = '00000000-0000-0000-0000-000000000002';
const U = '00000000-0000-0000-0000-000000000003';
const TH = '00000000-0000-0000-0000-000000000010';

const now = new Date();
const OLD_DATE = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000); // 15 days ago

function makeThread(overrides: Record<string, unknown> = {}) {
  return {
    id: TH,
    tenantId: T,
    projectId: P,
    question: 'テスト質問',
    submittedBy: U,
    answerCount: 0,
    lastAnsweredAt: null,
    upvoteCount: 0,
    status: 'open',
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    answers: [],
    upvotes: [],
    ...overrides,
  };
}

const mp = prisma as unknown as {
  ideaQaThread: Record<string, ReturnType<typeof vi.fn>>;
  ideaQaAnswer: Record<string, ReturnType<typeof vi.fn>>;
  ideaQaUpvote: Record<string, ReturnType<typeof vi.fn>>;
  ideaAssetLink: Record<string, ReturnType<typeof vi.fn>>;
  $transaction: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
};
const mGenEmbed = generateEmbedding as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// listQaThreads
// ============================================================
describe('listQaThreads', () => {
  it('スレッド一覧を返す', async () => {
    mp.ideaQaThread.findMany.mockResolvedValue([makeThread()]);
    const result = await listQaThreads(P, U, T);
    expect(result).toHaveLength(1);
    expect(result[0].question).toBe('テスト質問');
  });

  it('submittedBy を含まない', async () => {
    mp.ideaQaThread.findMany.mockResolvedValue([makeThread()]);
    const result = await listQaThreads(P, U, T);
    expect(Object.keys(result[0])).not.toContain('submittedBy');
  });

  it('stale フラグ: open かつ 14 日以上未回答で true', async () => {
    mp.ideaQaThread.findMany.mockResolvedValue([
      makeThread({ createdAt: OLD_DATE }),
    ]);
    const result = await listQaThreads(P, U, T);
    expect(result[0].isStale).toBe(true);
  });

  it('stale フラグ: 最終回答が 14 日以上前で true', async () => {
    mp.ideaQaThread.findMany.mockResolvedValue([
      makeThread({ answerCount: 1, lastAnsweredAt: OLD_DATE }),
    ]);
    const result = await listQaThreads(P, U, T);
    expect(result[0].isStale).toBe(true);
  });

  it('stale フラグ: closed は false', async () => {
    mp.ideaQaThread.findMany.mockResolvedValue([
      makeThread({ status: 'closed', createdAt: OLD_DATE }),
    ]);
    const result = await listQaThreads(P, U, T);
    expect(result[0].isStale).toBe(false);
  });

  it('hasUpvoted: 自分がいいね済みなら true', async () => {
    mp.ideaQaThread.findMany.mockResolvedValue([
      makeThread({ upvotes: [{ userId: U }] }),
    ]);
    const result = await listQaThreads(P, U, T);
    expect(result[0].hasUpvoted).toBe(true);
  });

  it('filter=unanswered は answerCount: 0 でフィルタする', async () => {
    mp.ideaQaThread.findMany.mockResolvedValue([]);
    await listQaThreads(P, U, T, 'createdAt', 'unanswered');
    expect(mp.ideaQaThread.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ answerCount: 0 }),
      }),
    );
  });

  it('q を渡すと question ILIKE フィルタが付与される', async () => {
    mp.ideaQaThread.findMany.mockResolvedValue([]);
    await listQaThreads(P, U, T, 'createdAt', 'all', 'テスト');
    expect(mp.ideaQaThread.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          question: { contains: 'テスト', mode: 'insensitive' },
        }),
      }),
    );
  });

  it('q が undefined のときは question フィルタを付与しない', async () => {
    mp.ideaQaThread.findMany.mockResolvedValue([]);
    await listQaThreads(P, U, T);
    const call = mp.ideaQaThread.findMany.mock.calls[0]?.[0];
    expect(call?.where).not.toHaveProperty('question');
  });
});

// ============================================================
// getQaThread
// ============================================================
describe('getQaThread', () => {
  it('NOT_FOUND を投げる', async () => {
    mp.ideaQaThread.findFirst.mockResolvedValue(null);
    await expect(getQaThread(TH, U, T)).rejects.toThrow('NOT_FOUND');
  });

  it('スレッドを DTO に変換して返す', async () => {
    mp.ideaQaThread.findFirst.mockResolvedValue(makeThread());
    const result = await getQaThread(TH, U, T);
    expect(result.question).toBe('テスト質問');
    expect(Object.keys(result)).not.toContain('submittedBy');
  });
});

// ============================================================
// createQaThread
// ============================================================
describe('createQaThread', () => {
  it('スレッドを作成して DTO を返す', async () => {
    mp.ideaQaThread.create.mockResolvedValue(makeThread());
    const result = await createQaThread(P, { question: 'テスト質問' }, U, T);
    expect(result.question).toBe('テスト質問');
    expect(mp.ideaQaThread.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ submittedBy: U }),
      }),
    );
  });
});

// ============================================================
// closeQaThread
// ============================================================
describe('closeQaThread', () => {
  it('投稿者がクローズできる', async () => {
    mGenEmbed.mockResolvedValue({ ok: false, reason: 'llm_error', message: 'skip' });
    mp.ideaQaThread.findFirst.mockResolvedValue(makeThread());
    mp.ideaQaThread.update.mockResolvedValue(makeThread({ status: 'closed' }));
    await expect(closeQaThread(TH, U, T)).resolves.toBeDefined();
  });

  it('投稿者以外は FORBIDDEN', async () => {
    mp.ideaQaThread.findFirst.mockResolvedValue(makeThread({ submittedBy: 'other' }));
    await expect(closeQaThread(TH, U, T)).rejects.toThrow('FORBIDDEN');
  });

  it('既クローズは ALREADY_CLOSED', async () => {
    mp.ideaQaThread.findFirst.mockResolvedValue(makeThread({ status: 'closed' }));
    await expect(closeQaThread(TH, U, T)).rejects.toThrow('ALREADY_CLOSED');
  });

  it('embedding 生成成功時は $executeRaw で content_embedding を更新する', async () => {
    const fakeEmbedding = Array.from({ length: 1024 }, (_, i) => i * 0.001);
    mGenEmbed.mockResolvedValue({ ok: true, embedding: fakeEmbedding, costJpy: 5, requestId: 'req-1' });
    mp.ideaQaThread.findFirst.mockResolvedValue(
      makeThread({ answers: [{ id: 'a1', content: '回答テスト', createdAt: new Date(), updatedAt: new Date() }] }),
    );
    mp.ideaQaThread.update.mockResolvedValue({});
    mp.$executeRaw.mockResolvedValue(1);

    await closeQaThread(TH, U, T);
    // fire-and-forget なので完了を待つために flushPromises が必要
    await new Promise((r) => setTimeout(r, 0));

    expect(mGenEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ featureUnit: 'idea-qa-embedding', tenantId: T, userId: U }),
    );
    expect(mp.$executeRaw).toHaveBeenCalled();
  });

  it('embedding 生成失敗時もクローズ自体は成功する', async () => {
    mGenEmbed.mockResolvedValue({ ok: false, reason: 'llm_error', message: 'voyage error' });
    mp.ideaQaThread.findFirst.mockResolvedValue(makeThread());
    mp.ideaQaThread.update.mockResolvedValue({});

    const result = await closeQaThread(TH, U, T);
    await new Promise((r) => setTimeout(r, 0));

    expect(result.status).toBe('closed');
    expect(mp.$executeRaw).not.toHaveBeenCalled();
  });
});

// ============================================================
// createAnswer
// ============================================================
describe('createAnswer', () => {
  it('回答を作成して answerCount をインクリメントする', async () => {
    mp.ideaQaThread.findFirst.mockResolvedValue({ id: TH });
    const answer = {
      id: 'a-1',
      content: '回答',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const updated = makeThread({ answerCount: 1 });
    mp.$transaction.mockResolvedValue([answer, updated]);

    const result = await createAnswer(TH, { content: '回答' }, U, T);
    expect(result.content).toBe('回答');
    expect(Object.keys(result)).not.toContain('submittedBy');
  });

  it('NOT_FOUND を投げる', async () => {
    mp.ideaQaThread.findFirst.mockResolvedValue(null);
    await expect(createAnswer(TH, { content: '回答' }, U, T)).rejects.toThrow('NOT_FOUND');
  });
});

// ============================================================
// toggleUpvote
// ============================================================
describe('toggleUpvote', () => {
  it('未いいねの場合は追加する', async () => {
    mp.ideaQaThread.findFirst.mockResolvedValue({ id: TH, upvoteCount: 0 });
    mp.ideaQaUpvote.findUnique.mockResolvedValue(null);
    mp.$transaction.mockResolvedValue([{}, {}]);

    const result = await toggleUpvote(TH, U, T);
    expect(result.hasUpvoted).toBe(true);
    expect(result.upvoteCount).toBe(1);
  });

  it('いいね済みの場合は削除する', async () => {
    mp.ideaQaThread.findFirst.mockResolvedValue({ id: TH, upvoteCount: 3 });
    mp.ideaQaUpvote.findUnique.mockResolvedValue({ id: 'upvote-1' });
    mp.$transaction.mockResolvedValue([{}, {}]);

    const result = await toggleUpvote(TH, U, T);
    expect(result.hasUpvoted).toBe(false);
    expect(result.upvoteCount).toBe(2);
  });
});

// ============================================================
// deleteQaThread
// ============================================================
describe('deleteQaThread', () => {
  it('投稿者が削除できる', async () => {
    mp.ideaQaThread.findFirst.mockResolvedValue({ submittedBy: U });
    mp.ideaQaThread.update.mockResolvedValue({});
    await expect(deleteQaThread(TH, U, T)).resolves.toBeUndefined();
  });

  it('NOT_FOUND を投げる', async () => {
    mp.ideaQaThread.findFirst.mockResolvedValue(null);
    await expect(deleteQaThread(TH, U, T)).rejects.toThrow('NOT_FOUND');
  });

  it('投稿者以外は FORBIDDEN', async () => {
    mp.ideaQaThread.findFirst.mockResolvedValue({ submittedBy: 'other' });
    await expect(deleteQaThread(TH, U, T)).rejects.toThrow('FORBIDDEN');
  });
});
