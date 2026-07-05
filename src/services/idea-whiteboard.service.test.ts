import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    ideaWhiteboardSession: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    ideaWhiteboardNote: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('@/services/embedding.service', () => ({
  generateEmbedding: vi.fn(),
}));

import {
  listWhiteboardSessions,
  getWhiteboardSession,
  createWhiteboardSession,
  closeWhiteboardSession,
  createNote,
  updateNote,
  deleteNote,
  deleteWhiteboardSession,
} from './idea-whiteboard.service';
import { prisma } from '@/lib/db';
import { generateEmbedding } from '@/services/embedding.service';

const T = '00000000-0000-0000-0000-000000000001';
const P = '00000000-0000-0000-0000-000000000002';
const U = '00000000-0000-0000-0000-000000000003';
const S = '00000000-0000-0000-0000-000000000010';
const N = '00000000-0000-0000-0000-000000000020';

const FUTURE = new Date(Date.now() + 3_600_000);
const PAST = new Date(Date.now() - 1000);

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: S,
    tenantId: T,
    projectId: P,
    title: 'テストボード',
    description: null,
    status: 'active',
    endsAt: FUTURE,
    createdBy: U,
    updatedBy: U,
    closedBy: null,
    closedAt: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    notes: [],
    ...overrides,
  };
}

function makeNote(overrides: Record<string, unknown> = {}) {
  return {
    id: N,
    sessionId: S,
    tenantId: T,
    submittedBy: U,
    content: 'テスト付箋',
    category: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    session: { status: 'active', endsAt: FUTURE },
    ...overrides,
  };
}

const mp = prisma as unknown as {
  ideaWhiteboardSession: Record<string, ReturnType<typeof vi.fn>>;
  ideaWhiteboardNote: Record<string, ReturnType<typeof vi.fn>>;
  $executeRaw: ReturnType<typeof vi.fn>;
};
const mGenEmbed = generateEmbedding as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// listWhiteboardSessions
// ============================================================
describe('listWhiteboardSessions', () => {
  it('セッション一覧を返す', async () => {
    mp.ideaWhiteboardSession.findMany.mockResolvedValue([makeSession()]);
    mp.ideaWhiteboardSession.updateMany.mockResolvedValue({ count: 0 });

    const result = await listWhiteboardSessions(P, U, T);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('テストボード');
  });

  it('endsAt 過去のセッションを自動クローズする', async () => {
    mp.ideaWhiteboardSession.findMany.mockResolvedValue([makeSession({ endsAt: PAST })]);
    mp.ideaWhiteboardSession.updateMany.mockResolvedValue({ count: 1 });

    const result = await listWhiteboardSessions(P, U, T);
    expect(mp.ideaWhiteboardSession.updateMany).toHaveBeenCalled();
    expect(result[0].status).toBe('closed');
  });

  it('status フィルタを渡すと where 条件に含まれる', async () => {
    mp.ideaWhiteboardSession.findMany.mockResolvedValue([]);
    mp.ideaWhiteboardSession.updateMany.mockResolvedValue({ count: 0 });

    await listWhiteboardSessions(P, U, T, 'closed');
    expect(mp.ideaWhiteboardSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'closed' }),
      }),
    );
  });

  it('q を渡すと title ILIKE フィルタが付与される', async () => {
    mp.ideaWhiteboardSession.findMany.mockResolvedValue([]);
    mp.ideaWhiteboardSession.updateMany.mockResolvedValue({ count: 0 });

    await listWhiteboardSessions(P, U, T, undefined, 'ブレスト');
    expect(mp.ideaWhiteboardSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          title: { contains: 'ブレスト', mode: 'insensitive' },
        }),
      }),
    );
  });

  it('status と q が両方 undefined のときはフィルタなし', async () => {
    mp.ideaWhiteboardSession.findMany.mockResolvedValue([]);
    mp.ideaWhiteboardSession.updateMany.mockResolvedValue({ count: 0 });

    await listWhiteboardSessions(P, U, T);
    const call = mp.ideaWhiteboardSession.findMany.mock.calls[0]?.[0];
    expect(call?.where).not.toHaveProperty('status');
    expect(call?.where).not.toHaveProperty('title');
  });
});

// ============================================================
// getWhiteboardSession
// ============================================================
describe('getWhiteboardSession', () => {
  it('NOT_FOUND を投げる', async () => {
    mp.ideaWhiteboardSession.findFirst.mockResolvedValue(null);
    await expect(getWhiteboardSession(S, U, T)).rejects.toThrow('NOT_FOUND');
  });

  it('アクティブ中は自分の付箋のみ返す', async () => {
    const ownNote = makeNote();
    const otherNote = makeNote({ id: 'n2', submittedBy: 'other' });
    mp.ideaWhiteboardSession.findFirst.mockResolvedValue(
      makeSession({ notes: [ownNote, otherNote] }),
    );
    mp.ideaWhiteboardSession.updateMany.mockResolvedValue({ count: 0 });

    const result = await getWhiteboardSession(S, U, T);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].isOwnNote).toBe(true);
    expect(result.totalNotes).toBe(2);
  });

  it('クローズ後は全付箋を返す', async () => {
    const notes = [makeNote(), makeNote({ id: 'n2', submittedBy: 'other' })];
    mp.ideaWhiteboardSession.findFirst.mockResolvedValue(
      makeSession({ status: 'closed', notes }),
    );
    mp.ideaWhiteboardSession.updateMany.mockResolvedValue({ count: 0 });

    const result = await getWhiteboardSession(S, U, T);
    expect(result.notes).toHaveLength(2);
    expect(result.notes[0].isOwnNote).toBe(true);
    expect(result.notes[1].isOwnNote).toBe(false);
    // submittedBy は DTO に含まれない
    for (const n of result.notes) {
      expect(Object.keys(n)).not.toContain('submittedBy');
    }
  });
});

// ============================================================
// createWhiteboardSession
// ============================================================
describe('createWhiteboardSession', () => {
  it('セッションを作成する', async () => {
    mp.ideaWhiteboardSession.create.mockResolvedValue(makeSession());
    const input = { title: 'テストボード', endsAt: FUTURE.toISOString() };
    const result = await createWhiteboardSession(P, input, U, T);
    expect(result.title).toBe('テストボード');
  });

  it('過去の endsAt で INVALID_ENDS_AT を投げる', async () => {
    await expect(
      createWhiteboardSession(P, { title: 'x', endsAt: PAST.toISOString() }, U, T),
    ).rejects.toThrow('INVALID_ENDS_AT');
  });
});

// ============================================================
// closeWhiteboardSession
// ============================================================
describe('closeWhiteboardSession', () => {
  it('作成者がクローズできる', async () => {
    mGenEmbed.mockResolvedValue({ ok: false, reason: 'llm_error', message: 'skip' });
    mp.ideaWhiteboardSession.findFirst.mockResolvedValue(makeSession());
    mp.ideaWhiteboardSession.update.mockResolvedValue(makeSession({ status: 'closed' }));
    await expect(closeWhiteboardSession(S, U, T)).resolves.toBeDefined();
  });

  it('作成者以外は FORBIDDEN', async () => {
    mp.ideaWhiteboardSession.findFirst.mockResolvedValue(makeSession({ createdBy: 'other' }));
    await expect(closeWhiteboardSession(S, U, T)).rejects.toThrow('FORBIDDEN');
  });

  it('既クローズは ALREADY_CLOSED', async () => {
    mp.ideaWhiteboardSession.findFirst.mockResolvedValue(makeSession({ status: 'closed' }));
    await expect(closeWhiteboardSession(S, U, T)).rejects.toThrow('ALREADY_CLOSED');
  });

  it('embedding 生成成功時は $executeRaw で content_embedding を更新する', async () => {
    const fakeEmbedding = Array.from({ length: 1024 }, (_, i) => i * 0.001);
    mGenEmbed.mockResolvedValue({ ok: true, embedding: fakeEmbedding, costJpy: 5, requestId: 'req-1' });
    mp.ideaWhiteboardSession.findFirst.mockResolvedValue(
      makeSession({ notes: [{ id: 'n1', content: '付箋テスト', submittedBy: U, category: null, createdAt: new Date(), updatedAt: new Date(), deletedAt: null }] }),
    );
    mp.ideaWhiteboardSession.update.mockResolvedValue({});
    mp.$executeRaw.mockResolvedValue(1);

    await closeWhiteboardSession(S, U, T);
    await new Promise((r) => setTimeout(r, 0));

    expect(mGenEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ featureUnit: 'idea-whiteboard-embedding', tenantId: T, userId: U }),
    );
    expect(mp.$executeRaw).toHaveBeenCalled();
  });

  it('embedding 生成失敗時もクローズ自体は成功する', async () => {
    mGenEmbed.mockResolvedValue({ ok: false, reason: 'llm_error', message: 'voyage error' });
    mp.ideaWhiteboardSession.findFirst.mockResolvedValue(makeSession());
    mp.ideaWhiteboardSession.update.mockResolvedValue({});

    const result = await closeWhiteboardSession(S, U, T);
    await new Promise((r) => setTimeout(r, 0));

    expect(result.status).toBe('closed');
    expect(mp.$executeRaw).not.toHaveBeenCalled();
  });
});

// ============================================================
// createNote
// ============================================================
describe('createNote', () => {
  it('クローズ済みセッションへの投稿は SESSION_CLOSED', async () => {
    mp.ideaWhiteboardSession.findFirst.mockResolvedValue({ status: 'closed', endsAt: PAST });
    await expect(createNote(S, { content: 'test' }, U, T)).rejects.toThrow('SESSION_CLOSED');
  });

  it('付箋を作成して DTO を返す', async () => {
    mp.ideaWhiteboardSession.findFirst.mockResolvedValue({ status: 'active', endsAt: FUTURE });
    mp.ideaWhiteboardNote.create.mockResolvedValue(makeNote());
    const result = await createNote(S, { content: 'テスト付箋' }, U, T);
    expect(result.content).toBe('テスト付箋');
    expect(result.isOwnNote).toBe(true);
  });
});

// ============================================================
// updateNote / deleteNote
// ============================================================
describe('updateNote', () => {
  it('投稿者以外は FORBIDDEN', async () => {
    mp.ideaWhiteboardNote.findFirst.mockResolvedValue(makeNote({ submittedBy: 'other' }));
    await expect(updateNote(N, { content: 'new' }, U, T)).rejects.toThrow('FORBIDDEN');
  });

  it('クローズ済みセッションは SESSION_CLOSED', async () => {
    mp.ideaWhiteboardNote.findFirst.mockResolvedValue(
      makeNote({ session: { status: 'closed', endsAt: PAST } }),
    );
    await expect(updateNote(N, { content: 'new' }, U, T)).rejects.toThrow('SESSION_CLOSED');
  });
});

describe('deleteNote', () => {
  it('投稿者以外は FORBIDDEN', async () => {
    mp.ideaWhiteboardNote.findFirst.mockResolvedValue({ submittedBy: 'other' });
    await expect(deleteNote(N, U, T)).rejects.toThrow('FORBIDDEN');
  });

  it('存在しない場合 NOT_FOUND', async () => {
    mp.ideaWhiteboardNote.findFirst.mockResolvedValue(null);
    await expect(deleteNote(N, U, T)).rejects.toThrow('NOT_FOUND');
  });
});
