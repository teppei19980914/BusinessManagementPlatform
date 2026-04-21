import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    knowledge: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    projectMember: { findMany: vi.fn() },
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

  it('非 admin は public + 自身の draft のみ', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledge.count).mockResolvedValue(0);

    await listKnowledge({}, 'u-1', 'general');

    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call.where.OR).toEqual([
      { visibility: 'public' },
      { visibility: 'draft', createdBy: 'u-1' },
    ]);
  });

  it('keyword 指定 + 公開範囲フィルタは AND で組まれる', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledge.count).mockResolvedValue(0);

    await listKnowledge({ keyword: 'bug' }, 'u-1', 'general');

    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call.where.AND).toHaveLength(2);
    expect(call.where).not.toHaveProperty('OR');
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

  it('getKnowledge: 存在すれば DTO', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue(kRow() as never);
    const r = await getKnowledge('k-1');
    expect(r?.id).toBe('k-1');
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

  it('updateKnowledge: 指定フィールドのみ', async () => {
    vi.mocked(prisma.knowledge.update).mockResolvedValue(kRow() as never);
    await updateKnowledge('k-1', { title: 'new' }, 'u-1');

    const call = vi.mocked(prisma.knowledge.update).mock.calls[0][0];
    expect(call.data.title).toBe('new');
    expect(call.data.content).toBeUndefined();
  });

  it('deleteKnowledge: deletedAt セット', async () => {
    vi.mocked(prisma.knowledge.update).mockResolvedValue({} as never);
    await deleteKnowledge('k-1', 'u-1');

    expect(prisma.knowledge.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });
});
