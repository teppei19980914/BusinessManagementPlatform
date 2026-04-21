import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    retrospective: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    retrospectiveComment: { create: vi.fn() },
    projectMember: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

import {
  listRetrospectives,
  listAllRetrospectivesForViewer,
  createRetrospective,
  updateRetrospective,
  confirmRetrospective,
  deleteRetrospective,
  getRetrospective,
  addComment,
} from './retrospective.service';
import { prisma } from '@/lib/db';

const now = new Date('2026-04-21T10:00:00Z');
const conducted = new Date('2026-04-01T00:00:00Z');

const retRow = (o: Record<string, unknown> = {}) => ({
  id: 'ret-1',
  projectId: 'p-1',
  conductedDate: conducted,
  planSummary: 'plan',
  actualSummary: 'actual',
  goodPoints: 'good',
  problems: 'prob',
  improvements: 'imp',
  state: 'draft',
  visibility: 'public',
  createdBy: 'u-1',
  updatedBy: 'u-1',
  createdAt: now,
  updatedAt: now,
  comments: [],
  ...o,
});

describe('listRetrospectives', () => {
  beforeEach(() => vi.clearAllMocks());

  it('admin は visibility フィルタなし', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([retRow()] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    await listRetrospectives('p-1', 'admin-1', 'admin');

    const call = vi.mocked(prisma.retrospective.findMany).mock.calls[0][0];
    expect(call.where).not.toHaveProperty('OR');
  });

  it('非 admin は public + 自身の draft', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    await listRetrospectives('p-1', 'u-1', 'general');

    const call = vi.mocked(prisma.retrospective.findMany).mock.calls[0][0];
    expect(call.where.OR).toEqual([
      { visibility: 'public' },
      { visibility: 'draft', createdBy: 'u-1' },
    ]);
  });

  it('コメント userName は user.findMany で一括解決', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      retRow({
        comments: [
          { id: 'c1', userId: 'u-2', content: 'hi', createdAt: now },
          { id: 'c2', userId: 'u-3', content: 'yo', createdAt: now },
        ],
      }),
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: 'u-2', name: 'Bob' },
      { id: 'u-3', name: 'Carol' },
    ] as never);

    const r = await listRetrospectives('p-1', 'admin-1', 'admin');

    expect(r[0].comments[0].userName).toBe('Bob');
    expect(r[0].comments[1].userName).toBe('Carol');
    expect(prisma.user.findMany).toHaveBeenCalledOnce();
  });

  it('ユーザが見つからないコメントは 不明', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      retRow({
        comments: [{ id: 'c1', userId: 'u-missing', content: 'x', createdAt: now }],
      }),
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    const r = await listRetrospectives('p-1', 'admin-1', 'admin');

    expect(r[0].comments[0].userName).toBe('不明');
  });
});

describe('listAllRetrospectivesForViewer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('admin はマスキングなし', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      { ...retRow(), project: { id: 'p-1', name: 'PJ', deletedAt: null } },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: 'u-1', name: 'Alice' },
    ] as never);

    const r = await listAllRetrospectivesForViewer('admin-1', 'admin');

    expect(r[0].projectName).toBe('PJ');
    expect(r[0].createdByName).toBe('Alice');
  });

  it('非メンバーは projectName / createdByName を null', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([]);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      { ...retRow(), project: { id: 'p-1', name: 'PJ', deletedAt: null } },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    const r = await listAllRetrospectivesForViewer('u-99', 'general');

    expect(r[0].projectName).toBe(null);
    expect(r[0].createdByName).toBe(null);
    expect(r[0].canAccessProject).toBe(false);
  });

  it('admin に削除済みプロジェクトは projectDeleted=true', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      { ...retRow(), project: { id: 'p-1', name: 'X', deletedAt: new Date() } },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    const r = await listAllRetrospectivesForViewer('admin-1', 'admin');

    expect(r[0].projectDeleted).toBe(true);
    expect(r[0].canAccessProject).toBe(false);
  });
});

describe('createRetrospective', () => {
  beforeEach(() => vi.clearAllMocks());

  it('入力を Date に変換し visibility 既定 draft で保存', async () => {
    vi.mocked(prisma.retrospective.create).mockResolvedValue(retRow() as never);

    await createRetrospective(
      'p-1',
      {
        conductedDate: '2026-04-01',
        planSummary: '',
        actualSummary: '',
        goodPoints: '',
        problems: '',
        estimateGapFactors: null,
        scheduleGapFactors: null,
        qualityIssues: null,
        riskResponseEvaluation: null,
        improvements: '',
        knowledgeToShare: null,
      } as never,
      'u-1',
    );

    const call = vi.mocked(prisma.retrospective.create).mock.calls[0][0];
    expect(call.data.conductedDate).toBeInstanceOf(Date);
    expect(call.data.visibility).toBe('draft');
    expect(call.data.createdBy).toBe('u-1');
  });
});

describe('updateRetrospective', () => {
  beforeEach(() => vi.clearAllMocks());

  it('指定フィールドのみ data に積む', async () => {
    vi.mocked(prisma.retrospective.update).mockResolvedValue({} as never);
    await updateRetrospective('ret-1', { planSummary: 'new' }, 'u-1');

    const call = vi.mocked(prisma.retrospective.update).mock.calls[0][0];
    expect(call.data).toEqual({ updatedBy: 'u-1', planSummary: 'new' });
  });

  it('conductedDate は Date に変換', async () => {
    vi.mocked(prisma.retrospective.update).mockResolvedValue({} as never);
    await updateRetrospective('ret-1', { conductedDate: '2026-05-01' }, 'u-1');

    const call = vi.mocked(prisma.retrospective.update).mock.calls[0][0];
    expect(call.data.conductedDate).toBeInstanceOf(Date);
  });
});

describe('confirmRetrospective / deleteRetrospective', () => {
  beforeEach(() => vi.clearAllMocks());

  it('confirm: state=confirmed', async () => {
    vi.mocked(prisma.retrospective.update).mockResolvedValue({} as never);
    await confirmRetrospective('ret-1', 'u-1');

    expect(prisma.retrospective.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'confirmed' }),
      }),
    );
  });

  it('delete: deletedAt セット', async () => {
    vi.mocked(prisma.retrospective.update).mockResolvedValue({} as never);
    await deleteRetrospective('ret-1', 'u-1');

    expect(prisma.retrospective.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });
});

describe('getRetrospective / addComment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getRetrospective: 論理削除済みを除外', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({
      id: 'ret-1',
      projectId: 'p-1',
    } as never);

    const r = await getRetrospective('ret-1');
    expect(r?.id).toBe('ret-1');
    expect(prisma.retrospective.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ret-1', deletedAt: null } }),
    );
  });

  it('addComment: コメント作成', async () => {
    vi.mocked(prisma.retrospectiveComment.create).mockResolvedValue({} as never);
    await addComment('ret-1', 'hello', 'u-1');

    expect(prisma.retrospectiveComment.create).toHaveBeenCalledWith({
      data: { retrospectiveId: 'ret-1', userId: 'u-1', content: 'hello' },
    });
  });
});
