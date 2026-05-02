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
    // PR #199: retrospectiveComment は polymorphic comments テーブルに統合済 → mock 不要
    projectMember: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    // PR #89: deleteRetrospective が attachment.updateMany を $transaction 内で呼ぶ
    attachment: { updateMany: vi.fn() },
    // PR fix/visibility-auth-matrix: deleteRetrospective も comment cascade
    comment: { updateMany: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

// PR #5-c (T-03 Phase 2): createRetrospective / updateRetrospective から呼ばれる embedding helper をモック
vi.mock('./embedding.service', () => ({
  generateAndPersistEntityEmbedding: vi.fn().mockResolvedValue(undefined),
}));

import {
  listRetrospectives,
  listAllRetrospectivesForViewer,
  createRetrospective,
  updateRetrospective,
  confirmRetrospective,
  deleteRetrospective,
  getRetrospective,
  // PR #199: addComment は削除 (polymorphic comments テーブルへ移行)
  bulkUpdateRetrospectivesVisibilityFromList,
} from './retrospective.service';
import { prisma } from '@/lib/db';
import { generateAndPersistEntityEmbedding } from './embedding.service';

const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001';

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
  // PR #199: comments は polymorphic comments テーブルへ移行 (DTO に含まれない)
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

  it('非 admin は public + 自分の draft (2026-05-01 仕様変更)', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    await listRetrospectives('p-1', 'u-1', 'general');

    const call = vi.mocked(prisma.retrospective.findMany).mock.calls[0][0];
    expect(call.where.OR).toEqual([
      { visibility: 'public' },
      { visibility: 'draft', createdBy: 'u-1' },
    ]);
    expect(call.where).not.toHaveProperty('visibility');
  });

  // PR #199: コメント関連の userName 解決テストは削除。コメントは
  //   polymorphic `comments` テーブル + `/api/comments` 経路に移行したため、
  //   retrospective.service の責務外。
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
      TEST_TENANT_ID,
    );

    const call = vi.mocked(prisma.retrospective.create).mock.calls[0][0];
    expect(call.data.conductedDate).toBeInstanceOf(Date);
    expect(call.data.visibility).toBe('draft');
    expect(call.data.createdBy).toBe('u-1');
  });

  // PR #5-c (T-03 Phase 2): 本体 INSERT 後に embedding helper が呼ばれる (fail-safe)
  it('createRetrospective: 本体作成後に generateAndPersistEntityEmbedding が呼ばれる', async () => {
    vi.mocked(prisma.retrospective.create).mockResolvedValue(retRow({ id: 'ret-new' }) as never);

    await createRetrospective(
      'p-1',
      {
        conductedDate: '2026-04-01',
        planSummary: '計画概要',
        actualSummary: '実績概要',
        goodPoints: 'good',
        problems: 'prob',
        improvements: 'imp',
        knowledgeToShare: 'share',
      } as never,
      'u-1',
      TEST_TENANT_ID,
    );

    expect(generateAndPersistEntityEmbedding).toHaveBeenCalledTimes(1);
    const args = vi.mocked(generateAndPersistEntityEmbedding).mock.calls[0][0];
    expect(args.table).toBe('retrospectives');
    expect(args.rowId).toBe('ret-new');
    expect(args.tenantId).toBe(TEST_TENANT_ID);
    expect(args.userId).toBe('u-1');
    expect(args.featureUnit).toBe('retrospective-embedding');
    expect(args.text).toContain('計画概要');
    expect(args.text).toContain('実績概要');
    expect(args.text).toContain('share');
  });
});

describe('updateRetrospective', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在しなければ NOT_FOUND', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue(null);
    await expect(
      updateRetrospective('x', { planSummary: 'n' }, 'u-1', TEST_TENANT_ID),
    ).rejects.toThrow('NOT_FOUND');
  });

  it('作成者以外 (admin でも) は FORBIDDEN', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    await expect(
      updateRetrospective('ret-1', { planSummary: 'n' }, 'u-other', TEST_TENANT_ID),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      updateRetrospective('ret-1', { planSummary: 'n' }, 'admin-x', TEST_TENANT_ID),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('作成者本人なら指定フィールドのみ data に積む', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    vi.mocked(prisma.retrospective.update).mockResolvedValue(retRow() as never);
    await updateRetrospective('ret-1', { planSummary: 'new' }, 'u-1', TEST_TENANT_ID);

    const call = vi.mocked(prisma.retrospective.update).mock.calls[0][0];
    expect(call.data).toEqual({ updatedBy: 'u-1', planSummary: 'new' });
  });

  it('conductedDate は Date に変換', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    vi.mocked(prisma.retrospective.update).mockResolvedValue(retRow() as never);
    await updateRetrospective('ret-1', { conductedDate: '2026-05-01' }, 'u-1', TEST_TENANT_ID);

    const call = vi.mocked(prisma.retrospective.update).mock.calls[0][0];
    expect(call.data.conductedDate).toBeInstanceOf(Date);
  });

  // PR #5-c: text フィールド変更時のみ embedding 再生成 (LLM 課金回避)
  it('updateRetrospective: text フィールド変更時は embedding を再生成する', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    vi.mocked(prisma.retrospective.update).mockResolvedValue(retRow() as never);

    await updateRetrospective('ret-1', { planSummary: 'new plan' }, 'u-1', TEST_TENANT_ID);

    expect(generateAndPersistEntityEmbedding).toHaveBeenCalledTimes(1);
    const args = vi.mocked(generateAndPersistEntityEmbedding).mock.calls[0][0];
    expect(args.table).toBe('retrospectives');
    expect(args.rowId).toBe('ret-1');
    expect(args.tenantId).toBe(TEST_TENANT_ID);
  });

  it('updateRetrospective: text フィールド非変更 (state/visibility のみ) は embedding 再生成しない', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    vi.mocked(prisma.retrospective.update).mockResolvedValue(retRow() as never);

    await updateRetrospective(
      'ret-1',
      { state: 'confirmed', visibility: 'public' },
      'u-1',
      TEST_TENANT_ID,
    );

    expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
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

describe('getRetrospective', () => {
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

  // PR #199: addComment テストは削除 (関数自体が削除されたため)。
  //   polymorphic comments の単体テストは src/services/comment.service.test.ts に新設。
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
