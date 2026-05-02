import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    comment: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    riskIssue: { findFirst: vi.fn() },
    retrospective: { findFirst: vi.fn() },
    knowledge: { findFirst: vi.fn() },
    task: { findFirst: vi.fn() },
    stakeholder: { findFirst: vi.fn() },
    customer: { findFirst: vi.fn() },
    memo: { findFirst: vi.fn() },
  },
}));

import {
  listComments,
  createComment,
  getComment,
  updateComment,
  deleteComment,
  resolveEntityForComment,
  softDeleteCommentsForEntity,
} from './comment.service';
import { prisma } from '@/lib/db';

const created = new Date('2026-04-21T10:00:00Z');
const updated = new Date('2026-04-21T10:00:00Z');

const row = (o: Record<string, unknown> = {}) => ({
  id: 'c-1',
  entityType: 'issue',
  entityId: 'r-1',
  userId: 'u-1',
  content: 'hello',
  user: { name: 'Alice' },
  createdAt: created,
  updatedAt: updated,
  ...o,
});

describe('listComments', () => {
  beforeEach(() => vi.clearAllMocks());

  it('entity 指定で deletedAt=null かつ createdAt DESC で取得する (要件 Q6)', async () => {
    vi.mocked(prisma.comment.findMany).mockResolvedValue([row()] as never);

    const r = await listComments('issue', 'r-1');

    expect(r).toHaveLength(1);
    expect(r[0].userName).toBe('Alice');
    const call = vi.mocked(prisma.comment.findMany).mock.calls[0][0]!;
    expect(call.where).toMatchObject({
      entityType: 'issue',
      entityId: 'r-1',
      deletedAt: null,
    });
    expect(call.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('user リレーションが null なら userName は null', async () => {
    vi.mocked(prisma.comment.findMany).mockResolvedValue([row({ user: null })] as never);
    const r = await listComments('issue', 'r-1');
    expect(r[0].userName).toBe(null);
  });

  it('createdAt と updatedAt が異なれば edited=true', async () => {
    vi.mocked(prisma.comment.findMany).mockResolvedValue([
      row({
        createdAt: new Date('2026-04-21T10:00:00Z'),
        updatedAt: new Date('2026-04-21T10:05:00Z'),
      }),
    ] as never);
    const r = await listComments('issue', 'r-1');
    expect(r[0].edited).toBe(true);
  });
});

describe('createComment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('userId を inject して comment を作る', async () => {
    vi.mocked(prisma.comment.create).mockResolvedValue(row() as never);
    await createComment({ entityType: 'issue', entityId: 'r-1', content: 'hi' }, 'u-99');

    const call = vi.mocked(prisma.comment.create).mock.calls[0][0]!;
    expect(call.data).toMatchObject({
      entityType: 'issue',
      entityId: 'r-1',
      userId: 'u-99',
      content: 'hi',
    });
  });
});

describe('getComment / updateComment / deleteComment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getComment: deletedAt=null のレコードのみ', async () => {
    vi.mocked(prisma.comment.findFirst).mockResolvedValue(row() as never);
    const c = await getComment('c-1');
    expect(c?.id).toBe('c-1');
    const call = vi.mocked(prisma.comment.findFirst).mock.calls[0][0]!;
    expect(call.where).toMatchObject({ id: 'c-1', deletedAt: null });
  });

  it('getComment: 不在なら null', async () => {
    vi.mocked(prisma.comment.findFirst).mockResolvedValue(null);
    const c = await getComment('missing');
    expect(c).toBeNull();
  });

  it('updateComment: content のみ更新 (updatedAt は @updatedAt 自動)', async () => {
    vi.mocked(prisma.comment.update).mockResolvedValue(row({ content: 'edited' }) as never);
    const c = await updateComment('c-1', 'edited');
    expect(c.content).toBe('edited');
    const call = vi.mocked(prisma.comment.update).mock.calls[0][0]!;
    expect(call.where).toEqual({ id: 'c-1' });
    expect(call.data).toEqual({ content: 'edited' });
  });

  it('deleteComment: deletedAt をセットする (soft delete)', async () => {
    vi.mocked(prisma.comment.update).mockResolvedValue({} as never);
    await deleteComment('c-1');
    const call = vi.mocked(prisma.comment.update).mock.calls[0][0]!;
    expect(call.where).toEqual({ id: 'c-1' });
    expect(call.data.deletedAt).toBeInstanceOf(Date);
  });
});

describe('resolveEntityForComment (2026-05-01: visibility 連動)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('issue (public): public-or-draft + visibility=public + creatorId', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      visibility: 'public', reporterId: 'u-1',
    } as never);
    const r = await resolveEntityForComment('issue', 'r-1');
    expect(r).toEqual({ kind: 'public-or-draft', visibility: 'public', creatorId: 'u-1' });
  });

  it('risk (draft): public-or-draft + visibility=draft + creatorId', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      visibility: 'draft', reporterId: 'u-1',
    } as never);
    const r = await resolveEntityForComment('risk', 'r-1');
    expect(r).toEqual({ kind: 'public-or-draft', visibility: 'draft', creatorId: 'u-1' });
  });

  it('retrospective (public): visibility + createdBy で creatorId 解決', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({
      visibility: 'public', createdBy: 'u-2',
    } as never);
    const r = await resolveEntityForComment('retrospective', 'rt-1');
    expect(r).toEqual({ kind: 'public-or-draft', visibility: 'public', creatorId: 'u-2' });
  });

  it('knowledge (draft): public-or-draft + visibility=draft + creatorId', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
      visibility: 'draft', createdBy: 'u-3',
    } as never);
    const r = await resolveEntityForComment('knowledge', 'k-1');
    expect(r).toEqual({ kind: 'public-or-draft', visibility: 'draft', creatorId: 'u-3' });
  });

  it('task: 存在すれば project-scoped (mention は ProjectMember、plain コメントは全員可)', async () => {
    // PR feat/notification-deep-link-completion (2026-05-01): task の plain コメントは緩和。
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ projectId: 'p-1' } as never);
    const r = await resolveEntityForComment('task', 't-1');
    expect(r).toEqual({
      kind: 'project-scoped',
      projectIds: ['p-1'],
      mentionRequiredRole: 'any',
      plainCommentScope: 'public',
    });
  });

  it('stakeholder: 存在すれば project-scoped (mention/plain ともに PM/TL のみ)', async () => {
    // PR feat/notification-edit-dialog (2026-05-01): stakeholder は PM/TL 限定。
    vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue({ projectId: 'p-1' } as never);
    const r = await resolveEntityForComment('stakeholder', 's-1');
    expect(r).toEqual({
      kind: 'project-scoped',
      projectIds: ['p-1'],
      mentionRequiredRole: 'pm_tl',
      plainCommentScope: 'project-member',
    });
  });

  it('customer: 存在すれば admin-only', async () => {
    vi.mocked(prisma.customer.findFirst).mockResolvedValue({ id: 'cus-1' } as never);
    const r = await resolveEntityForComment('customer', 'cus-1');
    expect(r).toEqual({ kind: 'admin-only' });
  });

  // PR #213: memo にコメント機能追加 (visibility-based 認可)
  it('memo (public): public-or-draft 扱い (誰でもコメント可)', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({
      visibility: 'public', userId: 'u-1',
    } as never);
    const r = await resolveEntityForComment('memo', 'm-1');
    expect(r).toEqual({ kind: 'public-or-draft', visibility: 'public', creatorId: 'u-1' });
  });

  it('memo (draft): public-or-draft 扱い (作成者のみコメント可)', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({
      visibility: 'draft', userId: 'u-2',
    } as never);
    const r = await resolveEntityForComment('memo', 'm-1');
    expect(r).toEqual({ kind: 'public-or-draft', visibility: 'draft', creatorId: 'u-2' });
  });

  it('memo: 不在なら not-found', async () => {
    vi.mocked(prisma.memo.findFirst).mockResolvedValue(null);
    expect(await resolveEntityForComment('memo', 'x')).toEqual({ kind: 'not-found' });
  });

  it('not-found: 各種で id が無効ならば not-found', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.task.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.customer.findFirst).mockResolvedValue(null);

    expect(await resolveEntityForComment('issue', 'x')).toEqual({ kind: 'not-found' });
    expect(await resolveEntityForComment('task', 'x')).toEqual({ kind: 'not-found' });
    expect(await resolveEntityForComment('customer', 'x')).toEqual({ kind: 'not-found' });
  });
});

describe('softDeleteCommentsForEntity (cascade 用)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('指定 entity に紐づく有効コメントを一括 soft-delete', async () => {
    vi.mocked(prisma.comment.updateMany).mockResolvedValue({ count: 2 } as never);
    await softDeleteCommentsForEntity('issue', 'r-1');
    const call = vi.mocked(prisma.comment.updateMany).mock.calls[0][0]!;
    expect(call.where).toMatchObject({ entityType: 'issue', entityId: 'r-1', deletedAt: null });
    expect(call.data.deletedAt).toBeInstanceOf(Date);
  });
});
