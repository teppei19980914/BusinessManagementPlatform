import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    memo: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      // PR #162: bulkUpdateMemosVisibilityFromCrossList が呼ぶ
      updateMany: vi.fn(),
    },
    // PR #89: deleteMemo が attachment.updateMany を $transaction 内で呼ぶ
    attachment: { updateMany: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

import {
  listMyMemos,
  listPublicMemos,
  getMemoForViewer,
  createMemo,
  updateMemo,
  deleteMemo,
  bulkUpdateMemosVisibilityFromCrossList,
} from './memo.service';
import { prisma } from '@/lib/db';

const now = new Date('2026-04-21T10:00:00Z');

const memoRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'memo-1',
  userId: 'user-1',
  title: 'T',
  content: 'C',
  visibility: 'private',
  createdAt: now,
  updatedAt: now,
  author: { name: 'Alice' },
  ...overrides,
});

describe('listMyMemos', () => {
  beforeEach(() => vi.clearAllMocks());

  it('自分のメモを新しい順で取得し DTO に変換する', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([
      memoRow({ id: 'a' }),
      memoRow({ id: 'b', visibility: 'public' }),
    ] as never);

    const result = await listMyMemos('user-1');

    expect(result).toHaveLength(2);
    expect(result[0].isMine).toBe(true);
    expect(result[0].authorName).toBe('Alice');
    expect(prisma.memo.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, userId: 'user-1' },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });
});

describe('listPublicMemos', () => {
  beforeEach(() => vi.clearAllMocks());

  it('public メモを全件取得し、自分のメモだけ isMine: true になる', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([
      memoRow({ id: 'a', userId: 'user-1', visibility: 'public' }),
      memoRow({ id: 'b', userId: 'user-2', visibility: 'public' }),
    ] as never);

    const result = await listPublicMemos('user-1');

    expect(result[0].isMine).toBe(true);
    expect(result[1].isMine).toBe(false);
    expect(prisma.memo.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null, visibility: 'public' } }),
    );
  });
});

describe('getMemoForViewer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在しなければ null', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(null);
    expect(await getMemoForViewer('x', 'user-1')).toBe(null);
  });

  it('本人なら private でも取得可', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(
      memoRow({ userId: 'user-1', visibility: 'private' }) as never,
    );
    const result = await getMemoForViewer('memo-1', 'user-1');
    expect(result?.isMine).toBe(true);
  });

  it('他人の private は null (漏洩防止)', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(
      memoRow({ userId: 'user-2', visibility: 'private' }) as never,
    );
    expect(await getMemoForViewer('memo-1', 'user-1')).toBe(null);
  });

  it('他人の public は取得可 (isMine: false)', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(
      memoRow({ userId: 'user-2', visibility: 'public' }) as never,
    );
    const result = await getMemoForViewer('memo-1', 'user-1');
    expect(result?.isMine).toBe(false);
  });
});

describe('createMemo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('visibility 未指定時は private', async () => {
    vi.mocked(prisma.memo.create).mockResolvedValue(
      memoRow({ visibility: 'private' }) as never,
    );
    await createMemo({ title: 't', content: 'c', visibility: 'private' }, 'user-1');
    expect(prisma.memo.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ visibility: 'private' }) }),
    );
  });

  it('public 指定でそのまま保存', async () => {
    vi.mocked(prisma.memo.create).mockResolvedValue(
      memoRow({ visibility: 'public' }) as never,
    );
    await createMemo({ title: 't', content: 'c', visibility: 'public' }, 'user-1');
    expect(prisma.memo.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ visibility: 'public' }) }),
    );
  });
});

describe('updateMemo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在しなければ null', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(null);
    expect(await updateMemo('x', { title: 't2' }, 'user-1')).toBe(null);
    expect(prisma.memo.update).not.toHaveBeenCalled();
  });

  it('他人のメモは更新不可 (null)', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({ userId: 'user-2' } as never);
    expect(await updateMemo('memo-1', { title: 't2' }, 'user-1')).toBe(null);
    expect(prisma.memo.update).not.toHaveBeenCalled();
  });

  it('作成者本人なら更新できる', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({ userId: 'user-1' } as never);
    vi.mocked(prisma.memo.update).mockResolvedValue(
      memoRow({ title: 't2' }) as never,
    );

    const result = await updateMemo('memo-1', { title: 't2' }, 'user-1');

    expect(result?.title).toBe('t2');
    expect(prisma.memo.update).toHaveBeenCalled();
  });
});

describe('deleteMemo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在しなければ false', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(null);
    expect(await deleteMemo('x', 'user-1')).toBe(false);
  });

  it('他人のメモは false', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({ userId: 'user-2' } as never);
    expect(await deleteMemo('memo-1', 'user-1')).toBe(false);
    expect(prisma.memo.update).not.toHaveBeenCalled();
  });

  it('本人なら論理削除して true', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({ userId: 'user-1' } as never);
    vi.mocked(prisma.memo.update).mockResolvedValue({} as never);

    expect(await deleteMemo('memo-1', 'user-1')).toBe(true);
    expect(prisma.memo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'memo-1' },
        data: { deletedAt: expect.any(Date) },
      }),
    );
  });
});

// PR #162 Phase 2: 横断ビューからの一括 visibility 更新。Memo は private/public 値域。
describe('bulkUpdateMemosVisibilityFromCrossList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ids 空 → updateMany 呼ばず 0 件', async () => {
    const r = await bulkUpdateMemosVisibilityFromCrossList([], 'private', 'u-1');
    expect(r).toEqual({ updatedIds: [], skippedNotOwned: 0, skippedNotFound: 0 });
    expect(prisma.memo.updateMany).not.toHaveBeenCalled();
  });

  it('userId 本人のみ updateMany される (他人混入は silent skip)', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([
      { id: 'memo-1', userId: 'u-1' },
      { id: 'memo-2', userId: 'u-OTHER' },
    ] as never);
    vi.mocked(prisma.memo.updateMany).mockResolvedValue({ count: 1 } as never);

    const r = await bulkUpdateMemosVisibilityFromCrossList(['memo-1', 'memo-2'], 'private', 'u-1');

    expect(r.updatedIds).toEqual(['memo-1']);
    expect(r.skippedNotOwned).toBe(1);

    const call = vi.mocked(prisma.memo.updateMany).mock.calls[0][0];
    expect(call.data).toEqual({ visibility: 'private' });
    // Memo は updatedBy 列を持たない (作成者本人のみ編集する設計、admin 特権なし)
    expect(call.data).not.toHaveProperty('updatedBy');
  });

  it('Memo は visibility="public" も受理 (private→public の bulk 公開)', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([
      { id: 'memo-1', userId: 'u-1' },
    ] as never);
    vi.mocked(prisma.memo.updateMany).mockResolvedValue({ count: 1 } as never);

    const r = await bulkUpdateMemosVisibilityFromCrossList(['memo-1'], 'public', 'u-1');
    expect(r.updatedIds).toEqual(['memo-1']);
    expect(vi.mocked(prisma.memo.updateMany).mock.calls[0][0].data).toEqual({ visibility: 'public' });
  });
});
