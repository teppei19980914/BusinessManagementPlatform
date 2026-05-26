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
  generateAndPersistBatchEmbeddings: vi.fn().mockResolvedValue({ generated: 0, failed: 0, costJpy: 0 }),
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
import { generateAndPersistEntityEmbedding, generateAndPersistBatchEmbeddings } from './embedding.service';

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
  // feat/asset-assignee-expansion (2026-05-26)
  assigneeId: null,
  assignee: null,
  createdAt: now,
  updatedAt: now,
  knowledgeProjects: [],
  ...o,
});

describe('listKnowledge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('admin は権限フィルタ無しで全件 (deletedAt + tenantId + isSampleData=false の AND)', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledge.count).mockResolvedValue(0);

    await listKnowledge({}, 'admin-1', 'admin', 'tenant-A');

    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    // 2026-05-08: super_admin 以外は isSampleData=false でシードナレッジを除外
    // 2026-05-09 Phase 2-4: tenantId フィルタ必須化
    expect(call.where.AND).toEqual([
      { deletedAt: null },
      { tenantId: 'tenant-A' },
      { isSampleData: false },
    ]);
  });

  it('super_admin はシードナレッジも表示 (isSampleData フィルタ無し)', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledge.count).mockResolvedValue(0);

    await listKnowledge({}, 'super-1', 'super_admin', 'tenant-A');

    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    // super_admin は isSampleData フィルタ無し + visibility 制限も無し
    // ただし tenantId フィルタは必須 (Phase 2-4)
    expect(call.where.AND).toEqual([{ deletedAt: null }, { tenantId: 'tenant-A' }]);
  });

  it('非 admin は public + 自分の draft + isSampleData=false (2026-05-01/05-08 仕様)', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledge.count).mockResolvedValue(0);

    await listKnowledge({}, 'u-1', 'general', 'tenant-A');

    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call.where.AND).toContainEqual({ deletedAt: null });
    expect(call.where.AND).toContainEqual({ isSampleData: false });
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

    await listKnowledge({ keyword: 'bug' }, 'u-1', 'general', 'tenant-A');

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
      'tenant-A',
    );
    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call.where.AND).toContainEqual({ knowledgeType: 'pattern' });
    expect(call.where.AND).toContainEqual({ visibility: 'public' });
  });

  it('ページング: limit 上限は 100', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledge.count).mockResolvedValue(0);

    await listKnowledge({ limit: 999, page: 2 }, 'admin-1', 'admin', 'tenant-A');
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

    const r = await listAllKnowledgeForViewer('admin-1', 'admin', 'tenant-A');
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

    const r = await listAllKnowledgeForViewer('u-99', 'general', 'tenant-A');
    expect(r[0].projectName).toBe(null); // プロジェクト名は機微扱い維持
    expect(r[0].updatedByName).toBe('Up'); // 氏名は公開
    expect(r[0].canAccessProject).toBe(false);
  });

  it('孤児ナレッジ (紐付けゼロ) は primaryProjectId null', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      { ...kRow(), updater: null, knowledgeProjects: [] },
    ] as never);

    const r = await listAllKnowledgeForViewer('admin-1', 'admin', 'tenant-A');
    expect(r[0].primaryProjectId).toBe(null);
    expect(r[0].canAccessProject).toBe(false);
  });

  it('2026-04-25: visibility フィルタは admin/非 admin 共に public 固定 (全○○ には draft を含めない)', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([]);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);

    // 非 admin
    await listAllKnowledgeForViewer('u-1', 'general', 'tenant-A');
    const generalCall = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(generalCall.where.visibility).toBe('public');
    expect(generalCall.where).not.toHaveProperty('OR');

    vi.clearAllMocks();
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);

    // admin (旧仕様では visibility 制約なしだったが、要件変更で admin も public 固定)
    await listAllKnowledgeForViewer('admin-1', 'admin', 'tenant-A');
    const adminCall = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(adminCall.where.visibility).toBe('public');
  });
});

describe('listKnowledgeByProject / getKnowledge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('listKnowledgeByProject: knowledgeProjects.some.projectId でフィルタ', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    await listKnowledgeByProject('p-1', 't-1');
    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call.where.knowledgeProjects.some.projectId).toBe('p-1');
  });

  // 2026-05-11: 公開範囲 (visibility) フィルタを viewer 単位で適用するリグレッション防止テスト。
  //   「自分のみ (draft)」を選んだナレッジが他のプロジェクトメンバーに見えてはならない。
  it('listKnowledgeByProject: 非 admin は public + 自分の draft のみ (他人の draft は除外)', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    await listKnowledgeByProject('p-1', 't-1', 'u-self', 'general');
    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call.where.OR).toEqual([
      { visibility: 'public' },
      { visibility: 'draft', createdBy: 'u-self' },
    ]);
  });

  it('listKnowledgeByProject: admin は draft も含めて全件閲覧可', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    await listKnowledgeByProject('p-1', 't-1', 'u-admin', 'admin');
    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    // admin の場合は visibility フィルタなし (OR が undefined)
    expect(call.where.OR).toBeUndefined();
  });

  it('listKnowledgeByProject: super_admin も全件閲覧可', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    await listKnowledgeByProject('p-1', 't-1', 'u-super', 'super_admin');
    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call.where.OR).toBeUndefined();
  });

  it('listKnowledgeByProject: viewerUserId 省略 (内部呼び出し) は全件返却 (cascade 削除等の運用)', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    await listKnowledgeByProject('p-1', 't-1');
    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call.where.OR).toBeUndefined();
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
    vi.mocked(prisma.knowledge.create).mockResolvedValue(kRow({ id: 'k-new', visibility: 'public' }) as never);
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

  // PR #357 (2026-05-14): 「公開範囲: 自分のみ」(visibility='draft') では embedding 生成しない
  it('createKnowledge: visibility=draft なら embedding を生成しない (Voyage API 課金を発生させない)', async () => {
    vi.mocked(prisma.knowledge.create).mockResolvedValue(kRow({ id: 'k-draft', visibility: 'draft' }) as never);
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
        visibility: 'draft',
      } as never,
      'u-1',
      TEST_TENANT_ID,
    );
    expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
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

  it('updateKnowledge: 作成者でも担当者でもない (admin でも) は FORBIDDEN', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue(
      { createdBy: 'u-1', assigneeId: null } as never,
    );
    await expect(updateKnowledge('k-1', { title: 'n' }, 'u-other', TEST_TENANT_ID)).rejects.toThrow(
      'FORBIDDEN',
    );
    await expect(updateKnowledge('k-1', { title: 'n' }, 'admin-x', TEST_TENANT_ID)).rejects.toThrow(
      'FORBIDDEN',
    );
  });

  // feat/asset-assignee-expansion (2026-05-26): 担当者も update 可能
  it('updateKnowledge: 担当者 (assigneeId === userId) は更新可能', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue(
      { createdBy: 'u-creator', assigneeId: 'u-assignee', visibility: 'draft' } as never,
    );
    vi.mocked(prisma.knowledge.update).mockResolvedValue(kRow() as never);
    await updateKnowledge('k-1', { title: 'updated' }, 'u-assignee', TEST_TENANT_ID);

    const call = vi.mocked(prisma.knowledge.update).mock.calls[0][0];
    expect(call.data.title).toBe('updated');
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
  it('updateKnowledge: text フィールド変更時は embedding を再生成する (public → public)', async () => {
    // PR #357 (2026-05-14): visibility が既に public のとき + text 変更で再生成 (現行仕様維持)
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
      createdBy: 'u-1',
      visibility: 'public',
    } as never);
    vi.mocked(prisma.knowledge.update).mockResolvedValue(kRow() as never);
    await updateKnowledge('k-1', { title: 'new title' }, 'u-1', TEST_TENANT_ID);

    expect(generateAndPersistEntityEmbedding).toHaveBeenCalledTimes(1);
    const args = vi.mocked(generateAndPersistEntityEmbedding).mock.calls[0][0];
    expect(args.table).toBe('knowledges');
    expect(args.rowId).toBe('k-1');
    expect(args.tenantId).toBe(TEST_TENANT_ID);
  });

  it('updateKnowledge: public → public で text 非変更 (visibility 維持のみ) は embedding 再生成しない', async () => {
    // 2026-05-11: defense-in-depth が「public 化時に DB の既存 title が空でない」ことを要求するため、
    //   findFirst モックで非空 title を返す必要がある (テスト整合性のため)。
    // PR #357: 既存 visibility=public 維持なら text 変更なしで再生成しない。
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
      createdBy: 'u-1',
      title: '既存タイトル',
      background: '',
      content: '',
      result: '',
      conclusion: null,
      recommendation: null,
      visibility: 'public',
    } as never);
    vi.mocked(prisma.knowledge.update).mockResolvedValue(kRow() as never);
    await updateKnowledge('k-1', { visibility: 'public' }, 'u-1', TEST_TENANT_ID);

    expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
  });

  // 2026-05-11: defense-in-depth テスト — `{ visibility: 'public' }` のみ送信 + DB title 空のとき拒否
  it('updateKnowledge: public 化時に DB の title が空なら PUBLIC_REQUIRES_TITLE をスロー (defense-in-depth)', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
      createdBy: 'u-1',
      title: '', // 既存が空タイトル (draft で作成された)
      background: '',
      content: '',
      result: '',
      conclusion: null,
      recommendation: null,
    } as never);
    await expect(
      updateKnowledge('k-1', { visibility: 'public' }, 'u-1', TEST_TENANT_ID),
    ).rejects.toThrow('PUBLIC_REQUIRES_TITLE');
  });

  it('updateKnowledge: public 化時に input.title 空 + DB title 空でも拒否 (空白のみも対象)', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
      createdBy: 'u-1',
      title: '既存',
      background: '', content: '', result: '',
      conclusion: null, recommendation: null,
    } as never);
    await expect(
      updateKnowledge('k-1', { visibility: 'public', title: '   ' }, 'u-1', TEST_TENANT_ID),
    ).rejects.toThrow('PUBLIC_REQUIRES_TITLE');
  });

  // ================================================================
  // PR #357 (2026-05-14): visibility 状態遷移 × embedding 生成マトリクス
  // ================================================================
  describe('PR #357: visibility 状態遷移 × embedding 生成判定', () => {
    const baseExisting = {
      createdBy: 'u-1',
      title: '既存',
      background: '既存背景',
      content: '既存内容',
      result: '既存結果',
      conclusion: null,
      recommendation: null,
    };

    it('draft → draft (text 変更なし) → 呼ばれない', async () => {
      vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
        ...baseExisting, visibility: 'draft',
      } as never);
      vi.mocked(prisma.knowledge.update).mockResolvedValue(kRow({ visibility: 'draft' }) as never);
      await updateKnowledge('k-1', { visibility: 'draft' }, 'u-1', TEST_TENANT_ID);
      expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
    });

    it('draft → draft (text 変更あり) → 呼ばれない (draft は提案候補外なので課金しない)', async () => {
      vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
        ...baseExisting, visibility: 'draft',
      } as never);
      vi.mocked(prisma.knowledge.update).mockResolvedValue(kRow({ visibility: 'draft' }) as never);
      await updateKnowledge('k-1', { title: '新タイトル', visibility: 'draft' }, 'u-1', TEST_TENANT_ID);
      expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
    });

    it('draft → public (text 変更なし) → 呼ばれる (公開化時の初回生成)', async () => {
      vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
        ...baseExisting, visibility: 'draft',
      } as never);
      vi.mocked(prisma.knowledge.update).mockResolvedValue(kRow({ visibility: 'public' }) as never);
      await updateKnowledge('k-1', { visibility: 'public' }, 'u-1', TEST_TENANT_ID);
      expect(generateAndPersistEntityEmbedding).toHaveBeenCalledTimes(1);
    });

    it('public → public (text 変更あり) → 呼ばれる', async () => {
      vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
        ...baseExisting, visibility: 'public',
      } as never);
      vi.mocked(prisma.knowledge.update).mockResolvedValue(kRow({ visibility: 'public' }) as never);
      await updateKnowledge('k-1', { title: '新タイトル' }, 'u-1', TEST_TENANT_ID);
      expect(generateAndPersistEntityEmbedding).toHaveBeenCalledTimes(1);
    });

    it('public → draft (text 変更あり) → 呼ばれない (既存 embedding は保持)', async () => {
      vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({
        ...baseExisting, visibility: 'public',
      } as never);
      vi.mocked(prisma.knowledge.update).mockResolvedValue(kRow({ visibility: 'draft' }) as never);
      await updateKnowledge(
        'k-1',
        { title: '新タイトル', visibility: 'draft' },
        'u-1',
        TEST_TENANT_ID,
      );
      expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
    });
  });

  it('deleteKnowledge: 存在しなければ NOT_FOUND', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue(null);
    await expect(deleteKnowledge('x', 'u-1', 'general', TEST_TENANT_ID, 'project')).rejects.toThrow('NOT_FOUND');
  });

  // feat/crud-permission-redesign (2026-05-20): context='project' = 作成者本人のみ可
  it('deleteKnowledge (context=project): 作成者本人は deletedAt セット', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    vi.mocked(prisma.knowledge.update).mockResolvedValue({} as never);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 0 } as never);
    await deleteKnowledge('k-1', 'u-1', 'general', TEST_TENANT_ID, 'project');

    expect(prisma.knowledge.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });

  it('deleteKnowledge (context=project): admin も他人作成は FORBIDDEN', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    await expect(
      deleteKnowledge('k-1', 'admin-x', 'admin', TEST_TENANT_ID, 'project'),
    ).rejects.toThrow('FORBIDDEN');
    expect(prisma.knowledge.update).not.toHaveBeenCalled();
  });

  it('deleteKnowledge (context=global): admin は他人作成も削除可', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    vi.mocked(prisma.knowledge.update).mockResolvedValue({} as never);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 0 } as never);
    await deleteKnowledge('k-1', 'admin-x', 'admin', TEST_TENANT_ID, 'global');
    expect(prisma.knowledge.update).toHaveBeenCalled();
  });

  it('deleteKnowledge (context=global): 非 admin (作成者本人) も FORBIDDEN', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    await expect(
      deleteKnowledge('k-1', 'u-1', 'general', TEST_TENANT_ID, 'global'),
    ).rejects.toThrow('FORBIDDEN');
    expect(prisma.knowledge.update).not.toHaveBeenCalled();
  });

  it('deleteKnowledge (context=project): 非 admin の第三者は FORBIDDEN', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue(
      { createdBy: 'u-1', assigneeId: null } as never,
    );
    await expect(
      deleteKnowledge('k-1', 'u-other', 'general', TEST_TENANT_ID, 'project'),
    ).rejects.toThrow('FORBIDDEN');
  });

  // feat/asset-assignee-expansion (2026-05-26): 担当者も削除可能 (project context)
  it('deleteKnowledge (context=project): 担当者は削除可能', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue(
      { createdBy: 'u-creator', assigneeId: 'u-assignee' } as never,
    );
    vi.mocked(prisma.knowledge.update).mockResolvedValue({} as never);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 0 } as never);

    await deleteKnowledge('k-1', 'u-assignee', 'general', TEST_TENANT_ID, 'project');

    expect(prisma.knowledge.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });
});

// PR #162 → PR #165 で project-scoped に。プロジェクト「ナレッジ一覧」からの一括 visibility 更新。
describe('bulkUpdateKnowledgeVisibilityFromList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ids 空 → updateMany 呼ばず 0 件', async () => {
    const r = await bulkUpdateKnowledgeVisibilityFromList('p-1', [], 'draft', 'u-1', 't-1');
    expect(r).toEqual({
      updatedIds: [],
      skippedNotOwned: 0,
      skippedNotFound: 0,
      skippedEmptyTitle: 0,
      embeddingsGenerated: 0,
    });
    expect(prisma.knowledge.updateMany).not.toHaveBeenCalled();
  });

  it('createdBy 本人のみ updateMany される (他人混入は silent skip)', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      { id: 'k-1', createdBy: 'u-1', title: 'タイトル A' },
      { id: 'k-2', createdBy: 'u-OTHER', title: '他人のナレッジ' },
    ] as never);
    vi.mocked(prisma.knowledge.updateMany).mockResolvedValue({ count: 1 } as never);

    const r = await bulkUpdateKnowledgeVisibilityFromList('p-1', ['k-1', 'k-2'], 'draft', 'u-1', 't-1');

    expect(r.updatedIds).toEqual(['k-1']);
    expect(r.skippedNotOwned).toBe(1);

    // PR #165: findMany の where に knowledgeProjects.some.projectId が含まれることを確認 (多対多)
    const findCall = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(findCall.where).toMatchObject({
      id: { in: ['k-1', 'k-2'] },
      deletedAt: null,
      tenantId: 't-1',
      knowledgeProjects: { some: { projectId: 'p-1' } },
    });

    const call = vi.mocked(prisma.knowledge.updateMany).mock.calls[0][0];
    // updateMany は scalar updatedBy のみ受理する (relation connect 構文不可)
    expect(call.data).toEqual({ visibility: 'draft', updatedBy: 'u-1' });
  });

  // 2026-05-11: 「自分のみ」(draft) で空タイトル保存されたナレッジを「全メンバー」(public)
  //   に昇格させようとした場合、サーバ側 validator のルール (public はタイトル必須) と整合するため
  //   silent skip + skippedEmptyTitle を返す。
  it('draft→public 化時に空タイトルの行はスキップ', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      { id: 'k-1', createdBy: 'u-1', title: '正しい' },
      { id: 'k-empty', createdBy: 'u-1', title: '' },
    ] as never);
    vi.mocked(prisma.knowledge.updateMany).mockResolvedValue({ count: 1 } as never);

    const r = await bulkUpdateKnowledgeVisibilityFromList(
      'p-1',
      ['k-1', 'k-empty'],
      'public',
      'u-1',
      't-1',
    );

    expect(r.updatedIds).toEqual(['k-1']);
    expect(r.skippedEmptyTitle).toBe(1);
  });

  // UI_PATTERNS §35 (2026-05-24): bulk visibility 経路の embedding コスト最適化テスト。
  // 単発 updateKnowledge の判定マトリクスと整合: draft→public 遷移のみ embedding 対象。
  describe('embedding 生成 (コスト最適化)', () => {
    it('visibility=draft への変更は embedding を生成しない (Voyage 課金回避)', async () => {
      vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
        { id: 'k-1', createdBy: 'u-1', title: 't', visibility: 'public', background: 'b', content: 'c', result: 'r', conclusion: null, recommendation: null },
      ] as never);
      vi.mocked(prisma.knowledge.updateMany).mockResolvedValue({ count: 1 } as never);

      const r = await bulkUpdateKnowledgeVisibilityFromList('p-1', ['k-1'], 'draft', 'u-1', 't-1');
      expect(r.embeddingsGenerated).toBe(0);
      expect(generateAndPersistBatchEmbeddings).not.toHaveBeenCalled();
    });

    it('public→public のままなら embedding を生成しない (text 変更なしのため)', async () => {
      vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
        { id: 'k-1', createdBy: 'u-1', title: 't', visibility: 'public', background: 'b', content: 'c', result: 'r', conclusion: null, recommendation: null },
      ] as never);
      vi.mocked(prisma.knowledge.updateMany).mockResolvedValue({ count: 1 } as never);

      const r = await bulkUpdateKnowledgeVisibilityFromList('p-1', ['k-1'], 'public', 'u-1', 't-1');
      expect(r.embeddingsGenerated).toBe(0);
      expect(generateAndPersistBatchEmbeddings).not.toHaveBeenCalled();
    });

    it('draft→public 遷移行のみ batch で 1 ApiCallLog 集約 (既 public は除外)', async () => {
      vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
        { id: 'k-1', createdBy: 'u-1', title: 't1', visibility: 'draft', background: 'b1', content: 'c1', result: 'r1', conclusion: null, recommendation: null },
        { id: 'k-2', createdBy: 'u-1', title: 't2', visibility: 'draft', background: 'b2', content: 'c2', result: 'r2', conclusion: null, recommendation: null },
        // 既に public な行は除外される (text 変更なしのため)
        { id: 'k-3', createdBy: 'u-1', title: 't3', visibility: 'public', background: 'b3', content: 'c3', result: 'r3', conclusion: null, recommendation: null },
      ] as never);
      vi.mocked(prisma.knowledge.updateMany).mockResolvedValue({ count: 3 } as never);
      vi.mocked(generateAndPersistBatchEmbeddings).mockResolvedValue({ generated: 2, failed: 0, costJpy: 1 });

      const r = await bulkUpdateKnowledgeVisibilityFromList('p-1', ['k-1', 'k-2', 'k-3'], 'public', 'u-1', 't-1');

      expect(r.embeddingsGenerated).toBe(2);
      expect(generateAndPersistBatchEmbeddings).toHaveBeenCalledTimes(1);
      const args = vi.mocked(generateAndPersistBatchEmbeddings).mock.calls[0][0];
      expect(args.items).toHaveLength(2);
      expect(args.items.map((i) => i.rowId)).toEqual(['k-1', 'k-2']);
      expect(args.featureUnit).toBe('knowledge-embedding');
    });
  });
});
