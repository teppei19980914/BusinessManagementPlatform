import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    retrospective: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      // PR #162 / PR #165: bulkUpdateRetrospectivesVisibilityFromList が呼ぶ
      updateMany: vi.fn(),
    },
    retrospectiveComment: { create: vi.fn() },
    projectMember: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    // PR #89: deleteRetrospective が attachment.updateMany を $transaction 内で呼ぶ
    attachment: { updateMany: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
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
  bulkUpdateRetrospectivesVisibilityFromList,
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

  it('非 admin は public のみ (2026-04-24: 自分の draft も一覧除外)', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    await listRetrospectives('p-1', 'u-1', 'general');

    const call = vi.mocked(prisma.retrospective.findMany).mock.calls[0][0];
    expect(call.where.visibility).toBe('public');
    expect(call.where).not.toHaveProperty('OR');
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

  it('2026-04-25: visibility フィルタは admin/非 admin 共に public 固定 (全○○ には draft を含めない)', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([]);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    // 非 admin
    await listAllRetrospectivesForViewer('u-1', 'general');
    const generalCall = vi.mocked(prisma.retrospective.findMany).mock.calls[0][0];
    expect(generalCall.where.visibility).toBe('public');
    expect(generalCall.where).not.toHaveProperty('OR');

    vi.clearAllMocks();
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    // admin (旧仕様では visibility 制約なしだったが要件変更で admin も public 固定)
    await listAllRetrospectivesForViewer('admin-1', 'admin');
    const adminCall = vi.mocked(prisma.retrospective.findMany).mock.calls[0][0];
    expect(adminCall.where.visibility).toBe('public');
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

  it('存在しなければ NOT_FOUND', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue(null);
    await expect(updateRetrospective('x', { planSummary: 'n' }, 'u-1')).rejects.toThrow(
      'NOT_FOUND',
    );
  });

  it('作成者以外 (admin でも) は FORBIDDEN', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    await expect(updateRetrospective('ret-1', { planSummary: 'n' }, 'u-other')).rejects.toThrow(
      'FORBIDDEN',
    );
    await expect(updateRetrospective('ret-1', { planSummary: 'n' }, 'admin-x')).rejects.toThrow(
      'FORBIDDEN',
    );
  });

  it('作成者本人なら指定フィールドのみ data に積む', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    vi.mocked(prisma.retrospective.update).mockResolvedValue({} as never);
    await updateRetrospective('ret-1', { planSummary: 'new' }, 'u-1');

    const call = vi.mocked(prisma.retrospective.update).mock.calls[0][0];
    expect(call.data).toEqual({ updatedBy: 'u-1', planSummary: 'new' });
  });

  it('conductedDate は Date に変換', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
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

  it('delete 存在しなければ NOT_FOUND', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue(null);
    await expect(deleteRetrospective('x', 'u-1', 'general')).rejects.toThrow('NOT_FOUND');
  });

  it('delete 作成者本人は削除 OK', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    vi.mocked(prisma.retrospective.update).mockResolvedValue({} as never);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 0 } as never);
    await deleteRetrospective('ret-1', 'u-1', 'general');

    expect(prisma.retrospective.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });

  it('delete admin は他人の振り返りも削除可 (管理削除)', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    vi.mocked(prisma.retrospective.update).mockResolvedValue({} as never);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 0 } as never);
    await deleteRetrospective('ret-1', 'admin-x', 'admin');
    expect(prisma.retrospective.update).toHaveBeenCalled();
  });

  it('delete 非 admin の第三者は FORBIDDEN', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    await expect(deleteRetrospective('ret-1', 'u-other', 'general')).rejects.toThrow(
      'FORBIDDEN',
    );
  });
});

describe('getRetrospective / addComment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getRetrospective: 論理削除済みを除外 + 認可引数なしは生行', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({
      id: 'ret-1',
      projectId: 'p-1',
      createdBy: 'u-1',
      visibility: 'draft',
    } as never);

    const r = await getRetrospective('ret-1');
    expect(r?.id).toBe('ret-1');
  });

  it('getRetrospective: public は誰でも参照可', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({
      id: 'ret-1',
      projectId: 'p-1',
      createdBy: 'u-1',
      visibility: 'public',
    } as never);

    const r = await getRetrospective('ret-1', 'u-other', 'general');
    expect(r?.id).toBe('ret-1');
  });

  it('getRetrospective: draft は作成者/admin 以外なら null', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({
      id: 'ret-1',
      projectId: 'p-1',
      createdBy: 'u-1',
      visibility: 'draft',
    } as never);

    const r = await getRetrospective('ret-1', 'u-other', 'general');
    expect(r).toBe(null);
  });

  it('addComment: コメント作成', async () => {
    vi.mocked(prisma.retrospectiveComment.create).mockResolvedValue({} as never);
    await addComment('ret-1', 'hello', 'u-1');

    expect(prisma.retrospectiveComment.create).toHaveBeenCalledWith({
      data: { retrospectiveId: 'ret-1', userId: 'u-1', content: 'hello' },
    });
  });
});

// PR #162 → PR #165 で project-scoped に。プロジェクト「振り返り一覧」からの一括 visibility 更新。
describe('bulkUpdateRetrospectivesVisibilityFromList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ids が空配列なら updateMany を呼ばずに 0 件で返す', async () => {
    const r = await bulkUpdateRetrospectivesVisibilityFromList('p-1', [], 'draft', 'u-1');
    expect(r).toEqual({ updatedIds: [], skippedNotOwned: 0, skippedNotFound: 0 });
    expect(prisma.retrospective.updateMany).not.toHaveBeenCalled();
  });

  it('createdBy 本人のレコードのみ updateMany される (他人混入は silent skip)', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      { id: 'ret-1', createdBy: 'u-1' },
      { id: 'ret-2', createdBy: 'u-OTHER' }, // 他人
      { id: 'ret-3', createdBy: 'u-1' },
    ] as never);
    vi.mocked(prisma.retrospective.updateMany).mockResolvedValue({ count: 2 } as never);

    const r = await bulkUpdateRetrospectivesVisibilityFromList(
      'p-1',
      ['ret-1', 'ret-2', 'ret-3'],
      'draft',
      'u-1',
    );

    expect(r.updatedIds).toEqual(['ret-1', 'ret-3']);
    expect(r.skippedNotOwned).toBe(1);
    expect(r.skippedNotFound).toBe(0);

    // PR #165: findMany の where に projectId が含まれることを確認
    const findCall = vi.mocked(prisma.retrospective.findMany).mock.calls[0][0];
    expect(findCall.where).toEqual({ id: { in: ['ret-1', 'ret-2', 'ret-3'] }, projectId: 'p-1', deletedAt: null });

    const call = vi.mocked(prisma.retrospective.updateMany).mock.calls[0][0];
    expect(call.where).toEqual({ id: { in: ['ret-1', 'ret-3'] } });
    expect(call.data).toEqual({ visibility: 'draft', updatedBy: 'u-1' });
  });

  it('存在しない id は skippedNotFound にカウント', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      { id: 'ret-1', createdBy: 'u-1' },
    ] as never);
    vi.mocked(prisma.retrospective.updateMany).mockResolvedValue({ count: 1 } as never);

    const r = await bulkUpdateRetrospectivesVisibilityFromList('p-1', ['ret-1', 'ret-MISSING'], 'public', 'u-1');
    expect(r.skippedNotFound).toBe(1);
    expect(r.updatedIds).toEqual(['ret-1']);
  });

  it('全件他人なら updateMany を呼ばない', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      { id: 'ret-1', createdBy: 'u-OTHER' },
    ] as never);
    const r = await bulkUpdateRetrospectivesVisibilityFromList('p-1', ['ret-1'], 'draft', 'u-1');
    expect(r.updatedIds).toEqual([]);
    expect(r.skippedNotOwned).toBe(1);
    expect(prisma.retrospective.updateMany).not.toHaveBeenCalled();
  });
});
