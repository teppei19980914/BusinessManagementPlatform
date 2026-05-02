import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    knowledge: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
      // PR #162 / PR #165: bulkUpdateKnowledgeVisibilityFromList が呼ぶ
      updateMany: vi.fn(),
    },
    projectMember: { findMany: vi.fn() },
    // PR #89: deleteKnowledge が attachment.updateMany を $transaction 内で呼ぶ
    attachment: { updateMany: vi.fn() },
    // PR fix/visibility-auth-matrix: deleteKnowledge も comment cascade
    comment: { updateMany: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

// PR #5-c (T-03 Phase 2): createKnowledge / updateKnowledge から呼ばれる embedding helper をモック。
// 既定では何もせず終了 (本体 INSERT/UPDATE への副作用なし = fail-safe 設計の検証)。
// 各テストで `vi.mocked(generateAndPersistEntityEmbedding).mockClear()` 等で呼び出し検証可能。
vi.mock('./embedding.service', () => ({
  generateAndPersistEntityEmbedding: vi.fn().mockResolvedValue(undefined),
}));

import {
  listKnowledge,
  listAllKnowledgeForViewer,
  listKnowledgeByProject,
  getKnowledge,
  createKnowledge,
  updateKnowledge,
  deleteKnowledge,
  bulkUpdateKnowledgeVisibilityFromList,
} from './knowledge.service';
import { prisma } from '@/lib/db';
import { generateAndPersistEntityEmbedding } from './embedding.service';

const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001';

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

  it('admin は権限フィルタ無しで全件 (deletedAt のみ AND の中)', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledge.count).mockResolvedValue(0);

    await listKnowledge({}, 'admin-1', 'admin');

    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call.where.AND).toEqual([{ deletedAt: null }]);
  });

  it('非 admin は public + 自分の draft (2026-05-01 仕様変更)', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledge.count).mockResolvedValue(0);

    await listKnowledge({}, 'u-1', 'general');

    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call.where.AND).toContainEqual({ deletedAt: null });
    expect(call.where.AND).toContainEqual({
      OR: [
        { visibility: 'public' },
        { visibility: 'draft', createdBy: 'u-1' },
      ],
    });
  });

  it('keyword 指定時は AND 配列に title/content の OR が追加される (権限 OR と独立)', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledge.count).mockResolvedValue(0);

    await listKnowledge({ keyword: 'bug' }, 'u-1', 'general');

    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    // 権限 OR と keyword OR の 2 つが AND の中に並ぶ
    const andClauses = call.where.AND as Array<{ OR?: unknown[] }>;
    const ors = andClauses.filter((c) => Array.isArray(c.OR));
    expect(ors).toHaveLength(2);
    // keyword OR は title/content (権限 OR は visibility のみで title を含まない)
    const keywordOr = ors.find((c) => JSON.stringify(c.OR).includes('title'));
    expect(keywordOr?.OR).toHaveLength(2);
  });

  it('knowledgeType / visibility パラメータが AND に反映される', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledge.count).mockResolvedValue(0);

    await listKnowledge(
      { knowledgeType: 'pattern', visibility: 'public' },
      'admin-1',
      'admin',
    );
    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call.where.AND).toContainEqual({ knowledgeType: 'pattern' });
    expect(call.where.AND).toContainEqual({ visibility: 'public' });
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

  // fix/cross-list-non-member-columns (2026-04-27): 非メンバーでも更新者・作成者の
  // 氏名は公開する仕様に変更 (横断ナレッジ共有の促進)。projectName のみマスク維持。
  it('非メンバーは projectName のみマスク、氏名は公開 (2026-04-27 仕様変更)', async () => {
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
    expect(r[0].projectName).toBe(null); // プロジェクト名は機微扱い維持
    expect(r[0].updatedByName).toBe('Up'); // 氏名は公開
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
      TEST_TENANT_ID,
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
      TEST_TENANT_ID,
    );

    const call = vi.mocked(prisma.knowledge.create).mock.calls[0][0];
    expect(call.data.knowledgeProjects.create).toHaveLength(2);
  });

  // PR #5-c (T-03 Phase 2): 本体 INSERT 後に embedding helper が呼ばれる (fail-safe)
  it('createKnowledge: 本体作成後に generateAndPersistEntityEmbedding が呼ばれる', async () => {
    vi.mocked(prisma.knowledge.create).mockResolvedValue(kRow({ id: 'k-new' }) as never);
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
      } as never,
      'u-1',
      TEST_TENANT_ID,
    );

    expect(generateAndPersistEntityEmbedding).toHaveBeenCalledTimes(1);
    const args = vi.mocked(generateAndPersistEntityEmbedding).mock.calls[0][0];
    expect(args.table).toBe('knowledges');
    expect(args.rowId).toBe('k-new');
    expect(args.tenantId).toBe(TEST_TENANT_ID);
    expect(args.userId).toBe('u-1');
    expect(args.featureUnit).toBe('knowledge-embedding');
    // composeKnowledgeText: title / background / content / result を改行結合
    expect(args.text).toContain('t');
    expect(args.text).toContain('b');
    expect(args.text).toContain('c');
    expect(args.text).toContain('r');
  });
});

describe('updateKnowledge / deleteKnowledge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updateKnowledge: 存在しなければ NOT_FOUND', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue(null);
    await expect(updateKnowledge('x', { title: 'n' }, 'u-1', TEST_TENANT_ID)).rejects.toThrow(
      'NOT_FOUND',
    );
  });

  it('updateKnowledge: 作成者以外 (admin でも) は FORBIDDEN', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    await expect(updateKnowledge('k-1', { title: 'n' }, 'u-other', TEST_TENANT_ID)).rejects.toThrow(
      'FORBIDDEN',
    );
    await expect(updateKnowledge('k-1', { title: 'n' }, 'admin-x', TEST_TENANT_ID)).rejects.toThrow(
      'FORBIDDEN',
    );
  });

  it('updateKnowledge: 作成者本人なら指定フィールドのみ', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    vi.mocked(prisma.knowledge.update).mockResolvedValue(kRow() as never);
    await updateKnowledge('k-1', { title: 'new' }, 'u-1', TEST_TENANT_ID);

    const call = vi.mocked(prisma.knowledge.update).mock.calls[0][0];
    expect(call.data.title).toBe('new');
    expect(call.data.content).toBeUndefined();
  });

  // PR #5-c: text フィールド変更時のみ embedding 再生成 (LLM 課金回避)
  it('updateKnowledge: text フィールド変更時は embedding を再生成する', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    vi.mocked(prisma.knowledge.update).mockResolvedValue(kRow() as never);
    await updateKnowledge('k-1', { title: 'new title' }, 'u-1', TEST_TENANT_ID);

    expect(generateAndPersistEntityEmbedding).toHaveBeenCalledTimes(1);
    const args = vi.mocked(generateAndPersistEntityEmbedding).mock.calls[0][0];
    expect(args.table).toBe('knowledges');
    expect(args.rowId).toBe('k-1');
    expect(args.tenantId).toBe(TEST_TENANT_ID);
  });

  it('updateKnowledge: text フィールド非変更 (visibility のみ) は embedding 再生成しない', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    vi.mocked(prisma.knowledge.update).mockResolvedValue(kRow() as never);
    await updateKnowledge('k-1', { visibility: 'public' }, 'u-1', TEST_TENANT_ID);

    expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
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

// PR #162 → PR #165 で project-scoped に。プロジェクト「ナレッジ一覧」からの一括 visibility 更新。
describe('bulkUpdateKnowledgeVisibilityFromList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ids 空 → updateMany 呼ばず 0 件', async () => {
    const r = await bulkUpdateKnowledgeVisibilityFromList('p-1', [], 'draft', 'u-1');
    expect(r).toEqual({ updatedIds: [], skippedNotOwned: 0, skippedNotFound: 0 });
    expect(prisma.knowledge.updateMany).not.toHaveBeenCalled();
  });

  it('createdBy 本人のみ updateMany される (他人混入は silent skip)', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      { id: 'k-1', createdBy: 'u-1' },
      { id: 'k-2', createdBy: 'u-OTHER' },
    ] as never);
    vi.mocked(prisma.knowledge.updateMany).mockResolvedValue({ count: 1 } as never);

    const r = await bulkUpdateKnowledgeVisibilityFromList('p-1', ['k-1', 'k-2'], 'draft', 'u-1');

    expect(r.updatedIds).toEqual(['k-1']);
    expect(r.skippedNotOwned).toBe(1);

    // PR #165: findMany の where に knowledgeProjects.some.projectId が含まれることを確認 (多対多)
    const findCall = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(findCall.where).toEqual({
      id: { in: ['k-1', 'k-2'] },
      deletedAt: null,
      knowledgeProjects: { some: { projectId: 'p-1' } },
    });

    const call = vi.mocked(prisma.knowledge.updateMany).mock.calls[0][0];
    // updateMany は scalar updatedBy のみ受理する (relation connect 構文不可)
    expect(call.data).toEqual({ visibility: 'draft', updatedBy: 'u-1' });
  });
});
