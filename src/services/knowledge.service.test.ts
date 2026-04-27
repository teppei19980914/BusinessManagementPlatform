import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    knowledge: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
      // PR #162: bulkUpdateKnowledgeVisibilityFromCrossList が呼ぶ
      updateMany: vi.fn(),
    },
    projectMember: { findMany: vi.fn() },
    // PR #89: deleteKnowledge が attachment.updateMany を $transaction 内で呼ぶ
    attachment: { updateMany: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

import {
  listKnowledge,
  listAllKnowledgeForViewer,
  listKnowledgeByProject,
  getKnowledge,
  createKnowledge,
  updateKnowledge,
  deleteKnowledge,
  bulkUpdateKnowledgeVisibilityFromCrossList,
} from './knowledge.service';
import { prisma } from '@/lib/db';

const now = new Date('2026-04-21T10:00:00Z');

const kRow = (o: Record<string, unknown> = {}) => ({
  id: 'k-1',
  title: 'TITLE',
  knowledgeType: 'lesson_learned',
  background: '',
  content: '',
  result: '',
  conclusion: null,
  recommendation: null,
  reusability: null,
  techTags: [],
  devMethod: null,
  processTags: [],
  businessDomainTags: [],
  visibility: 'public',
  createdBy: 'u-1',
  creator: { name: 'Alice' },
  createdAt: now,
  updatedAt: now,
  knowledgeProjects: [],
  ...o,
});

describe('listKnowledge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('admin は visibility フィルタなしで全件を見られる', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledge.count).mockResolvedValue(0);

    await listKnowledge({}, 'admin-1', 'admin');

    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call.where).not.toHaveProperty('OR');
  });

  it('非 admin は public のみ (2026-04-24: 自分の draft も除外)', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledge.count).mockResolvedValue(0);

    await listKnowledge({}, 'u-1', 'general');

    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call.where.visibility).toBe('public');
    expect(call.where).not.toHaveProperty('OR');
  });

  it('keyword 指定時は OR で title/content 検索 (公開範囲は visibility スカラで別適用)', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledge.count).mockResolvedValue(0);

    await listKnowledge({ keyword: 'bug' }, 'u-1', 'general');

    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call.where.OR).toHaveLength(2);
    expect(call.where.visibility).toBe('public');
  });

  it('knowledgeType / visibility パラメータが where に反映される', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledge.count).mockResolvedValue(0);

    await listKnowledge(
      { knowledgeType: 'pattern', visibility: 'public' },
      'admin-1',
      'admin',
    );
    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call.where.knowledgeType).toBe('pattern');
    expect(call.where.visibility).toBe('public');
  });

  it('ページング: limit 上限は 100', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledge.count).mockResolvedValue(0);

    await listKnowledge({ limit: 999, page: 2 }, 'admin-1', 'admin');
    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call.take).toBe(100);
    expect(call.skip).toBe(100);
  });
});

describe('listAllKnowledgeForViewer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('admin はマスキングなし', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      {
        ...kRow(),
        updater: { name: 'Up' },
        knowledgeProjects: [
          { projectId: 'p-1', project: { id: 'p-1', name: 'PJ', deletedAt: null } },
        ],
      },
    ] as never);

    const r = await listAllKnowledgeForViewer('admin-1', 'admin');
    expect(r[0].projectName).toBe('PJ');
    expect(r[0].updatedByName).toBe('Up');
    expect(r[0].linkedProjectCount).toBe(1);
  });

  it('非メンバーは projectName をマスク', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      {
        ...kRow(),
        updater: { name: 'Up' },
        knowledgeProjects: [
          { projectId: 'p-1', project: { id: 'p-1', name: 'PJ', deletedAt: null } },
        ],
      },
    ] as never);

    const r = await listAllKnowledgeForViewer('u-99', 'general');
    expect(r[0].projectName).toBe(null);
    expect(r[0].updatedByName).toBe(null);
    expect(r[0].canAccessProject).toBe(false);
  });

  it('孤児ナレッジ (紐付けゼロ) は primaryProjectId null', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      { ...kRow(), updater: null, knowledgeProjects: [] },
    ] as never);

    const r = await listAllKnowledgeForViewer('admin-1', 'admin');
    expect(r[0].primaryProjectId).toBe(null);
    expect(r[0].canAccessProject).toBe(false);
  });

  it('2026-04-25: visibility フィルタは admin/非 admin 共に public 固定 (全○○ には draft を含めない)', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);

    // 非 admin
    await listAllKnowledgeForViewer('u-1', 'general');
    const generalCall = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(generalCall.where.visibility).toBe('public');
    expect(generalCall.where).not.toHaveProperty('OR');

    vi.clearAllMocks();
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);

    // admin (旧仕様では visibility 制約なしだったが、要件変更で admin も public 固定)
    await listAllKnowledgeForViewer('admin-1', 'admin');
    const adminCall = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(adminCall.where.visibility).toBe('public');
  });
});

describe('listKnowledgeByProject / getKnowledge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('listKnowledgeByProject: knowledgeProjects.some.projectId でフィルタ', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    await listKnowledgeByProject('p-1');
    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call.where.knowledgeProjects.some.projectId).toBe('p-1');
  });

  it('getKnowledge: 存在しなければ null', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue(null);
    expect(await getKnowledge('x')).toBe(null);
  });

  it('getKnowledge: 認可引数なしは生データ (内部用)', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue(
      kRow({ visibility: 'draft', createdBy: 'someone' }) as never,
    );
    const r = await getKnowledge('k-1');
    expect(r?.id).toBe('k-1');
  });

  it('getKnowledge: public は誰でも参照可', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue(
      kRow({ visibility: 'public' }) as never,
    );
    const r = await getKnowledge('k-1', 'u-other', 'general');
    expect(r?.id).toBe('k-1');
  });

  it('getKnowledge: draft は作成者本人/admin のみ参照可', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue(
      kRow({ visibility: 'draft', createdBy: 'u-1' }) as never,
    );
    expect((await getKnowledge('k-1', 'u-1', 'general'))?.id).toBe('k-1');
    expect((await getKnowledge('k-1', 'admin-x', 'admin'))?.id).toBe('k-1');
    expect(await getKnowledge('k-1', 'u-other', 'general')).toBe(null);
  });
});

describe('createKnowledge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('projectIds 指定なしでも作成できる (knowledgeProjects undefined)', async () => {
    vi.mocked(prisma.knowledge.create).mockResolvedValue(kRow() as never);
    await createKnowledge(
      {
        title: 't',
        knowledgeType: 'pattern',
        background: 'b',
        content: 'c',
        result: 'r',
        conclusion: null,
        recommendation: null,
        reusability: null,
        techTags: [],
        devMethod: null,
        processTags: [],
        businessDomainTags: [],
        visibility: 'public',
      } as never,
      'u-1',
    );

    const call = vi.mocked(prisma.knowledge.create).mock.calls[0][0];
    expect(call.data.knowledgeProjects).toBeUndefined();
  });

  it('projectIds 指定時は中間テーブルに create を展開', async () => {
    vi.mocked(prisma.knowledge.create).mockResolvedValue(kRow() as never);
    await createKnowledge(
      {
        title: 't',
        knowledgeType: 'pattern',
        background: 'b',
        content: 'c',
        result: 'r',
        techTags: [],
        processTags: [],
        businessDomainTags: [],
        visibility: 'public',
        projectIds: ['p1', 'p2'],
      } as never,
      'u-1',
    );

    const call = vi.mocked(prisma.knowledge.create).mock.calls[0][0];
    expect(call.data.knowledgeProjects.create).toHaveLength(2);
  });
});

describe('updateKnowledge / deleteKnowledge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updateKnowledge: 存在しなければ NOT_FOUND', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue(null);
    await expect(updateKnowledge('x', { title: 'n' }, 'u-1')).rejects.toThrow('NOT_FOUND');
  });

  it('updateKnowledge: 作成者以外 (admin でも) は FORBIDDEN', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    await expect(updateKnowledge('k-1', { title: 'n' }, 'u-other')).rejects.toThrow('FORBIDDEN');
    await expect(updateKnowledge('k-1', { title: 'n' }, 'admin-x')).rejects.toThrow('FORBIDDEN');
  });

  it('updateKnowledge: 作成者本人なら指定フィールドのみ', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    vi.mocked(prisma.knowledge.update).mockResolvedValue(kRow() as never);
    await updateKnowledge('k-1', { title: 'new' }, 'u-1');

    const call = vi.mocked(prisma.knowledge.update).mock.calls[0][0];
    expect(call.data.title).toBe('new');
    expect(call.data.content).toBeUndefined();
  });

  it('deleteKnowledge: 存在しなければ NOT_FOUND', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue(null);
    await expect(deleteKnowledge('x', 'u-1', 'general')).rejects.toThrow('NOT_FOUND');
  });

  it('deleteKnowledge: 作成者本人は deletedAt セット', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    vi.mocked(prisma.knowledge.update).mockResolvedValue({} as never);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 0 } as never);
    await deleteKnowledge('k-1', 'u-1', 'general');

    expect(prisma.knowledge.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });

  it('deleteKnowledge: admin は他人のナレッジも削除可', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    vi.mocked(prisma.knowledge.update).mockResolvedValue({} as never);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 0 } as never);
    await deleteKnowledge('k-1', 'admin-x', 'admin');
    expect(prisma.knowledge.update).toHaveBeenCalled();
  });

  it('deleteKnowledge: 非 admin の第三者は FORBIDDEN', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    await expect(deleteKnowledge('k-1', 'u-other', 'general')).rejects.toThrow('FORBIDDEN');
  });
});

// PR #162 Phase 2: 横断ビューからの一括 visibility 更新。PR #161 と同パターン。
describe('bulkUpdateKnowledgeVisibilityFromCrossList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ids 空 → updateMany 呼ばず 0 件', async () => {
    const r = await bulkUpdateKnowledgeVisibilityFromCrossList([], 'draft', 'u-1');
    expect(r).toEqual({ updatedIds: [], skippedNotOwned: 0, skippedNotFound: 0 });
    expect(prisma.knowledge.updateMany).not.toHaveBeenCalled();
  });

  it('createdBy 本人のみ updateMany される (他人混入は silent skip)', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      { id: 'k-1', createdBy: 'u-1' },
      { id: 'k-2', createdBy: 'u-OTHER' },
    ] as never);
    vi.mocked(prisma.knowledge.updateMany).mockResolvedValue({ count: 1 } as never);

    const r = await bulkUpdateKnowledgeVisibilityFromCrossList(['k-1', 'k-2'], 'draft', 'u-1');

    expect(r.updatedIds).toEqual(['k-1']);
    expect(r.skippedNotOwned).toBe(1);

    const call = vi.mocked(prisma.knowledge.updateMany).mock.calls[0][0];
    // updateMany は scalar updatedBy のみ受理する (relation connect 構文不可)
    expect(call.data).toEqual({ visibility: 'draft', updatedBy: 'u-1' });
  });
});
