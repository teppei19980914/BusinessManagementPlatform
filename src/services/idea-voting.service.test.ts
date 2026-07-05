import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    ideaVotingSession: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    ideaVotingSubmission: {
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        ideaVotingSubmission: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          create: vi.fn().mockResolvedValue({}),
        },
      }),
    ),
    $executeRaw: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('@/services/embedding.service', () => ({
  generateEmbedding: vi.fn(),
}));

import {
  listVotingSessions,
  getVotingSession,
  createVotingSession,
  closeVotingSession,
  submitVote,
  deleteVotingSession,
} from './idea-voting.service';
import { prisma } from '@/lib/db';
import { generateEmbedding } from '@/services/embedding.service';

const T = '00000000-0000-0000-0000-000000000001';
const P = '00000000-0000-0000-0000-000000000002';
const U = '00000000-0000-0000-0000-000000000003';
const S = '00000000-0000-0000-0000-000000000010';
const O1 = '00000000-0000-0000-0000-000000000020';
const O2 = '00000000-0000-0000-0000-000000000021';

const FUTURE = new Date(Date.now() + 3_600_000);
const PAST = new Date(Date.now() - 1000);

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: S,
    tenantId: T,
    projectId: P,
    kind: 'live',
    voteType: 'binary',
    title: 'テスト投票',
    description: null,
    votesPerMember: null,
    status: 'active',
    endsAt: FUTURE,
    createdBy: U,
    updatedBy: U,
    closedBy: null,
    closedAt: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    options: [
      { id: O1, sessionId: S, label: '賛成', displayOrder: 0, createdAt: new Date() },
      { id: O2, sessionId: S, label: '反対', displayOrder: 1, createdAt: new Date() },
    ],
    submissions: [],
    ...overrides,
  };
}

const mockedPrisma = prisma as unknown as {
  ideaVotingSession: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  $executeRaw: ReturnType<typeof vi.fn>;
};
const mGenEmbed = generateEmbedding as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// listVotingSessions
// ============================================================
describe('listVotingSessions', () => {
  it('セッション一覧を DTO に変換して返す', async () => {
    mockedPrisma.ideaVotingSession.findMany.mockResolvedValue([makeSession()]);
    mockedPrisma.ideaVotingSession.updateMany.mockResolvedValue({ count: 0 });

    const result = await listVotingSessions(P, U, T);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('テスト投票');
    expect(result[0].status).toBe('active');
    expect(result[0].totalRespondents).toBe(0);
  });

  it('endsAt が過去のセッションを自動クローズする', async () => {
    mockedPrisma.ideaVotingSession.findMany.mockResolvedValue([makeSession({ endsAt: PAST })]);
    mockedPrisma.ideaVotingSession.updateMany.mockResolvedValue({ count: 1 });

    const result = await listVotingSessions(P, U, T);
    expect(mockedPrisma.ideaVotingSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'closed' }) }),
    );
    expect(result[0].status).toBe('closed');
  });

  it('kind フィルタを渡すと where 条件に含まれる', async () => {
    mockedPrisma.ideaVotingSession.findMany.mockResolvedValue([]);
    mockedPrisma.ideaVotingSession.updateMany.mockResolvedValue({ count: 0 });

    await listVotingSessions(P, U, T, 'pre');
    expect(mockedPrisma.ideaVotingSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ kind: 'pre' }) }),
    );
  });

  it('status フィルタを渡すと where 条件に含まれる', async () => {
    mockedPrisma.ideaVotingSession.findMany.mockResolvedValue([]);
    mockedPrisma.ideaVotingSession.updateMany.mockResolvedValue({ count: 0 });

    await listVotingSessions(P, U, T, undefined, 'closed');
    expect(mockedPrisma.ideaVotingSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'closed' }) }),
    );
  });

  it('q を渡すと title ILIKE フィルタが付与される', async () => {
    mockedPrisma.ideaVotingSession.findMany.mockResolvedValue([]);
    mockedPrisma.ideaVotingSession.updateMany.mockResolvedValue({ count: 0 });

    await listVotingSessions(P, U, T, undefined, undefined, 'テスト投票');
    expect(mockedPrisma.ideaVotingSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          title: { contains: 'テスト投票', mode: 'insensitive' },
        }),
      }),
    );
  });

  it('status と q が undefined のときは where 条件に付与しない', async () => {
    mockedPrisma.ideaVotingSession.findMany.mockResolvedValue([]);
    mockedPrisma.ideaVotingSession.updateMany.mockResolvedValue({ count: 0 });

    await listVotingSessions(P, U, T);
    const call = mockedPrisma.ideaVotingSession.findMany.mock.calls[0]?.[0];
    expect(call?.where).not.toHaveProperty('title');
  });
});

// ============================================================
// getVotingSession
// ============================================================
describe('getVotingSession', () => {
  it('存在しない場合 NOT_FOUND を投げる', async () => {
    mockedPrisma.ideaVotingSession.findFirst.mockResolvedValue(null);
    await expect(getVotingSession(S, U, T)).rejects.toThrow('NOT_FOUND');
  });

  it('アクティブ中は自分の提出のみ返す', async () => {
    const sub = {
      id: 'sub-1',
      submittedBy: U,
      reason: 'ok',
      allocations: [{ optionId: O1, votes: 1 }],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockedPrisma.ideaVotingSession.findFirst.mockResolvedValue(makeSession({ submissions: [sub] }));
    mockedPrisma.ideaVotingSession.updateMany.mockResolvedValue({ count: 0 });

    const result = await getVotingSession(S, U, T);
    expect(result.submissions).toHaveLength(1);
    expect(result.submissions[0].isOwnSubmission).toBe(true);
    expect(result.hasSubmitted).toBe(true);
  });

  it('アクティブ中は他人の提出を返さない', async () => {
    const sub = {
      id: 'sub-2',
      submittedBy: 'other-user',
      reason: null,
      allocations: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockedPrisma.ideaVotingSession.findFirst.mockResolvedValue(makeSession({ submissions: [sub] }));
    mockedPrisma.ideaVotingSession.updateMany.mockResolvedValue({ count: 0 });

    const result = await getVotingSession(S, U, T);
    expect(result.submissions).toHaveLength(0);
    expect(result.hasSubmitted).toBe(false);
    expect(result.totalRespondents).toBe(1);
  });

  it('クローズ後は全提出を返し isOwnSubmission フラグを付与する', async () => {
    const subs = [
      { id: 's1', submittedBy: U, reason: 'own', allocations: [{ optionId: O1, votes: 1 }], createdAt: new Date(), updatedAt: new Date() },
      { id: 's2', submittedBy: 'other', reason: null, allocations: [{ optionId: O2, votes: 1 }], createdAt: new Date(), updatedAt: new Date() },
    ];
    mockedPrisma.ideaVotingSession.findFirst.mockResolvedValue(
      makeSession({ status: 'closed', submissions: subs }),
    );
    mockedPrisma.ideaVotingSession.updateMany.mockResolvedValue({ count: 0 });

    const result = await getVotingSession(S, U, T);
    expect(result.submissions).toHaveLength(2);
    expect(result.submissions[0].isOwnSubmission).toBe(true);
    expect(result.submissions[1].isOwnSubmission).toBe(false);
    // submittedBy は含まれない
    for (const sub of result.submissions) {
      expect(Object.keys(sub)).not.toContain('submittedBy');
    }
  });
});

// ============================================================
// createVotingSession
// ============================================================
describe('createVotingSession', () => {
  it('セッションを作成して DTO を返す', async () => {
    const created = makeSession();
    mockedPrisma.ideaVotingSession.create.mockResolvedValue(created);

    const input = {
      kind: 'live' as const,
      voteType: 'binary' as const,
      title: 'テスト投票',
      endsAt: FUTURE.toISOString(),
      options: [
        { label: '賛成', displayOrder: 0 },
        { label: '反対', displayOrder: 1 },
      ],
    };
    const result = await createVotingSession(P, input, U, T);
    expect(result.title).toBe('テスト投票');
    expect(mockedPrisma.ideaVotingSession.create).toHaveBeenCalledOnce();
  });

  it('過去の endsAt の場合 INVALID_ENDS_AT を投げる', async () => {
    const input = {
      kind: 'live' as const,
      voteType: 'binary' as const,
      title: 'テスト',
      endsAt: PAST.toISOString(),
      options: [
        { label: 'A', displayOrder: 0 },
        { label: 'B', displayOrder: 1 },
      ],
    };
    await expect(createVotingSession(P, input, U, T)).rejects.toThrow('INVALID_ENDS_AT');
  });
});

// ============================================================
// closeVotingSession
// ============================================================
describe('closeVotingSession', () => {
  it('作成者が手動クローズできる', async () => {
    mGenEmbed.mockResolvedValue({ ok: false, reason: 'llm_error', message: 'skip' });
    mockedPrisma.ideaVotingSession.findFirst.mockResolvedValue(makeSession());
    mockedPrisma.ideaVotingSession.update.mockResolvedValue(makeSession({ status: 'closed' }));

    await expect(closeVotingSession(S, U, T)).resolves.toBeDefined();
    expect(mockedPrisma.ideaVotingSession.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'closed' }) }),
    );
  });

  it('作成者以外は FORBIDDEN を投げる', async () => {
    mockedPrisma.ideaVotingSession.findFirst.mockResolvedValue(makeSession({ createdBy: 'other' }));
    await expect(closeVotingSession(S, U, T)).rejects.toThrow('FORBIDDEN');
  });

  it('既にクローズ済みは ALREADY_CLOSED を投げる', async () => {
    mockedPrisma.ideaVotingSession.findFirst.mockResolvedValue(makeSession({ status: 'closed' }));
    await expect(closeVotingSession(S, U, T)).rejects.toThrow('ALREADY_CLOSED');
  });

  it('embedding 生成成功時は $executeRaw で content_embedding を更新する', async () => {
    const fakeEmbedding = Array.from({ length: 1024 }, (_, i) => i * 0.001);
    mGenEmbed.mockResolvedValue({ ok: true, embedding: fakeEmbedding, costJpy: 5, requestId: 'req-1' });
    mockedPrisma.ideaVotingSession.findFirst.mockResolvedValue(makeSession());
    mockedPrisma.ideaVotingSession.update.mockResolvedValue({});
    mockedPrisma.$executeRaw.mockResolvedValue(1);

    await closeVotingSession(S, U, T);
    await new Promise((r) => setTimeout(r, 0));

    expect(mGenEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ featureUnit: 'idea-voting-embedding', tenantId: T, userId: U }),
    );
    expect(mockedPrisma.$executeRaw).toHaveBeenCalled();
  });

  it('embedding 生成失敗時もクローズ自体は成功する', async () => {
    mGenEmbed.mockResolvedValue({ ok: false, reason: 'llm_error', message: 'voyage error' });
    mockedPrisma.ideaVotingSession.findFirst.mockResolvedValue(makeSession());
    mockedPrisma.ideaVotingSession.update.mockResolvedValue({});

    const result = await closeVotingSession(S, U, T);
    await new Promise((r) => setTimeout(r, 0));

    expect(result.status).toBe('closed');
    expect(mockedPrisma.$executeRaw).not.toHaveBeenCalled();
  });
});

// ============================================================
// submitVote
// ============================================================
describe('submitVote', () => {
  it('クローズ済みセッションへの投票は SESSION_CLOSED を投げる', async () => {
    mockedPrisma.ideaVotingSession.findFirst.mockResolvedValue(makeSession({ status: 'closed' }));
    mockedPrisma.ideaVotingSession.updateMany.mockResolvedValue({ count: 0 });

    const input = { allocations: [{ optionId: O1, votes: 1 }] };
    await expect(submitVote(S, input, U, T)).rejects.toThrow('SESSION_CLOSED');
  });

  it('dot 投票で votesPerMember を超えると DOT_VOTES_EXCEEDED を投げる', async () => {
    mockedPrisma.ideaVotingSession.findFirst.mockResolvedValue(
      makeSession({ voteType: 'dot', votesPerMember: 3 }),
    );
    mockedPrisma.ideaVotingSession.updateMany.mockResolvedValue({ count: 0 });

    const input = { allocations: [{ optionId: O1, votes: 4 }] };
    await expect(submitVote(S, input, U, T)).rejects.toThrow('DOT_VOTES_EXCEEDED');
  });
});

// ============================================================
// deleteVotingSession
// ============================================================
describe('deleteVotingSession', () => {
  it('作成者が削除できる', async () => {
    mockedPrisma.ideaVotingSession.findFirst.mockResolvedValue({ createdBy: U });
    mockedPrisma.ideaVotingSession.update.mockResolvedValue({});

    await expect(deleteVotingSession(S, U, T)).resolves.toBeUndefined();
  });

  it('存在しない場合 NOT_FOUND を投げる', async () => {
    mockedPrisma.ideaVotingSession.findFirst.mockResolvedValue(null);
    await expect(deleteVotingSession(S, U, T)).rejects.toThrow('NOT_FOUND');
  });

  it('作成者以外は FORBIDDEN を投げる', async () => {
    mockedPrisma.ideaVotingSession.findFirst.mockResolvedValue({ createdBy: 'other' });
    await expect(deleteVotingSession(S, U, T)).rejects.toThrow('FORBIDDEN');
  });
});
