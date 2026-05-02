import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    project: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    riskIssue: { findMany: vi.fn(), deleteMany: vi.fn() },
    retrospective: { findMany: vi.fn(), deleteMany: vi.fn() },
    comment: { deleteMany: vi.fn() },
    knowledgeProject: {
      findMany: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    knowledge: { delete: vi.fn() },
    task: { findMany: vi.fn(), deleteMany: vi.fn() },
    taskProgressLog: { deleteMany: vi.fn() },
    estimate: { findMany: vi.fn(), deleteMany: vi.fn() },
    projectMember: { deleteMany: vi.fn() },
    // PR #89: deleteProject + deleteProjectCascade は attachment を扱う
    attachment: { updateMany: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

vi.mock('./state-machine', () => ({
  canTransition: vi.fn(),
}));

// PR #3-b: createProject / updateProject から呼ばれる auto-tag 抽出をモック。
// 既定では「rate_limited で何も追加しない」モードにし、各テストで
// vi.mocked(extractAutoTags).mockResolvedValueOnce(...) で上書きする。
vi.mock('./auto-tag.service', () => ({
  extractAutoTags: vi.fn().mockResolvedValue({
    ok: false,
    reason: 'rate_limited',
    message: 'default mock — テストごとに上書きする',
  }),
}));

// PR #5 (T-03 Phase 2): createProject / updateProject から呼ばれる embedding をモック。
// 既定では「rate_limited で何もせず終了」モードにし、各テストで上書き可能。
// embedding 自体は project.service の本体動作 (本体 INSERT/UPDATE) に影響しない fail-safe 設計のため、
// テストでは generate と persist の呼び出し有無のみ検証する。
vi.mock('./embedding.service', () => ({
  generateEmbedding: vi.fn().mockResolvedValue({
    ok: false,
    reason: 'rate_limited',
    message: 'default mock — テストごとに上書きする',
  }),
  persistEmbedding: vi.fn().mockResolvedValue(1),
}));

vi.mock('./error-log.service', () => ({
  recordError: vi.fn(),
}));

import {
  listProjects,
  createProject,
  getProject,
  updateProject,
  changeProjectStatus,
  deleteProject,
  deleteProjectCascade,
} from './project.service';
import { prisma } from '@/lib/db';
import { canTransition } from './state-machine';
import { extractAutoTags } from './auto-tag.service';
import { generateEmbedding, persistEmbedding } from './embedding.service';
import { recordError } from './error-log.service';

const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001';

const now = new Date('2026-04-21T10:00:00Z');
const date = (s: string) => new Date(s);

const pRow = (o: Record<string, unknown> = {}) => ({
  id: 'p-1',
  name: 'Proj',
  // PR #111-2: customer_name 列廃止 → customer relation include 前提
  customerId: 'cust-1',
  customer: { name: 'Cust' },
  purpose: '',
  background: '',
  scope: '',
  outOfScope: null,
  devMethod: 'waterfall',
  businessDomainTags: [],
  techStackTags: [],
  processTags: [],
  plannedStartDate: date('2026-04-01'),
  plannedEndDate: date('2026-12-31'),
  status: 'planning',
  notes: null,
  createdBy: 'u-1',
  createdAt: now,
  updatedAt: now,
  ...o,
});

describe('listProjects', () => {
  beforeEach(() => vi.clearAllMocks());

  it('admin は全件 (members フィルタなし)', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([pRow()] as never);
    vi.mocked(prisma.project.count).mockResolvedValue(1);

    await listProjects({}, 'admin-1', 'admin');

    const call = vi.mocked(prisma.project.findMany).mock.calls[0][0];
    expect(call.where).not.toHaveProperty('members');
  });

  it('非 admin は自身がメンバーのみ', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([]);
    vi.mocked(prisma.project.count).mockResolvedValue(0);

    await listProjects({}, 'u-1', 'general');

    const call = vi.mocked(prisma.project.findMany).mock.calls[0][0];
    expect(call.where.members).toEqual({ some: { userId: 'u-1' } });
  });

  it('keyword でフィルタ (name/customer.name/purpose の OR)', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([]);
    vi.mocked(prisma.project.count).mockResolvedValue(0);

    await listProjects({ keyword: 'searchword' }, 'admin-1', 'admin');

    const call = vi.mocked(prisma.project.findMany).mock.calls[0][0];
    expect(call.where.OR).toHaveLength(3);
    // PR #111-2: customerName 列削除後は customer relation 経由でキーワード検索
    expect(call.where.OR).toEqual(
      expect.arrayContaining([
        { customer: { name: { contains: 'searchword', mode: 'insensitive' } } },
      ]),
    );
  });

  it('limit 上限 100, ページング', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([]);
    vi.mocked(prisma.project.count).mockResolvedValue(0);

    await listProjects({ limit: 999, page: 3 }, 'admin-1', 'admin');

    const call = vi.mocked(prisma.project.findMany).mock.calls[0][0];
    expect(call.take).toBe(100);
    expect(call.skip).toBe(200);
  });

  it('customerName パラメータは customer.name contains でフィルタ (PR #111-2)', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([]);
    vi.mocked(prisma.project.count).mockResolvedValue(0);

    await listProjects({ customerName: 'ACME' }, 'admin-1', 'admin');

    const call = vi.mocked(prisma.project.findMany).mock.calls[0][0];
    expect(call.where.customer).toEqual({
      name: { contains: 'ACME', mode: 'insensitive' },
    });
  });

  it('include: customer.name を取得し DTO に載せる (PR #111-2)', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([pRow()] as never);
    vi.mocked(prisma.project.count).mockResolvedValue(1);

    const result = await listProjects({}, 'admin-1', 'admin');

    const call = vi.mocked(prisma.project.findMany).mock.calls[0][0];
    expect(call.include).toEqual({ customer: { select: { name: true } } });
    expect(result.data[0].customerId).toBe('cust-1');
    expect(result.data[0].customerName).toBe('Cust');
  });
});

describe('createProject / getProject / updateProject / deleteProject', () => {
  beforeEach(() => vi.clearAllMocks());

  it('createProject: 日付 ISO を Date に変換、status=planning', async () => {
    vi.mocked(prisma.project.create).mockResolvedValue(pRow() as never);

    await createProject(
      {
        name: 'x',
        customerId: 'cust-1',
        purpose: '',
        background: '',
        scope: '',
        devMethod: 'waterfall',
        plannedStartDate: '2026-04-01',
        plannedEndDate: '2026-12-31',
      },
      'u-1',
      TEST_TENANT_ID,
    );

    const call = vi.mocked(prisma.project.create).mock.calls[0][0];
    expect(call.data.status).toBe('planning');
    expect(call.data.plannedStartDate).toBeInstanceOf(Date);
    // PR #111-2: customerId を direct FK として保存
    expect(call.data.customerId).toBe('cust-1');
    expect(call.include).toEqual({ customer: { select: { name: true } } });
  });

  it('updateProject: customerId 変更は customer.connect() に変換 (PR #111-2)', async () => {
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);
    await updateProject('p-1', { customerId: 'cust-new' }, 'u-1', TEST_TENANT_ID);
    const call = vi.mocked(prisma.project.update).mock.calls[0][0];
    expect(call.data.customer).toEqual({ connect: { id: 'cust-new' } });
    expect(call.include).toEqual({ customer: { select: { name: true } } });
  });

  it('getProject: 存在しなければ null', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null);
    expect(await getProject('x')).toBe(null);
  });

  it('updateProject: 指定フィールドのみ', async () => {
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);
    await updateProject('p-1', { name: 'new' }, 'u-1', TEST_TENANT_ID);

    const call = vi.mocked(prisma.project.update).mock.calls[0][0];
    expect(call.data.name).toBe('new');
    expect(call.data.purpose).toBeUndefined();
  });

  // ========================================================
  // PR #3-b (T-03 Phase 1): 自動タグ抽出フックの統合テスト
  // ========================================================

  it('createProject: extractAutoTags 成功時、user-provided + auto-extracted を union で保存', async () => {
    vi.mocked(prisma.project.create).mockResolvedValue(pRow() as never);
    vi.mocked(extractAutoTags).mockResolvedValueOnce({
      ok: true,
      tags: {
        businessDomainTags: ['EC', '物流'],
        techStackTags: ['Next.js'],
        processTags: ['設計'],
      },
      costJpy: 0,
      requestId: 'req-1',
    });

    await createProject(
      {
        name: 'x',
        customerId: 'cust-1',
        purpose: 'EC サイト構築',
        background: '既存システムの刷新',
        scope: 'フロント + 管理画面',
        devMethod: 'agile',
        plannedStartDate: '2026-04-01',
        plannedEndDate: '2026-12-31',
        businessDomainTags: ['EC', '小売'], // user-provided
        techStackTags: ['React'],
        // processTags は省略
      },
      'u-1',
      TEST_TENANT_ID,
    );

    const call = vi.mocked(prisma.project.create).mock.calls[0][0];
    // user の "EC" + auto の "EC" は重複除去で 1 件
    expect(call.data.businessDomainTags).toEqual(['EC', '小売', '物流']);
    // user の React + auto の Next.js は両方残る
    expect(call.data.techStackTags).toEqual(['React', 'Next.js']);
    // user 未提供 → auto のみ
    expect(call.data.processTags).toEqual(['設計']);
  });

  it('createProject: extractAutoTags が rate_limited 等で失敗時、user-provided のみで保存 (fail-safe)', async () => {
    vi.mocked(prisma.project.create).mockResolvedValue(pRow() as never);
    vi.mocked(extractAutoTags).mockResolvedValueOnce({
      ok: false,
      reason: 'rate_limited',
      message: 'rate limit',
    });

    await createProject(
      {
        name: 'x',
        customerId: 'cust-1',
        purpose: 'p',
        background: 'b',
        scope: 's',
        devMethod: 'waterfall',
        plannedStartDate: '2026-04-01',
        plannedEndDate: '2026-12-31',
        businessDomainTags: ['EC'],
      },
      'u-1',
      TEST_TENANT_ID,
    );

    const call = vi.mocked(prisma.project.create).mock.calls[0][0];
    expect(call.data.businessDomainTags).toEqual(['EC']);
    expect(call.data.techStackTags).toEqual([]);
    expect(call.data.processTags).toEqual([]);
  });

  it('createProject: extractAutoTags に正しい tenantId / userId / text が渡る', async () => {
    vi.mocked(prisma.project.create).mockResolvedValue(pRow() as never);
    vi.mocked(extractAutoTags).mockResolvedValueOnce({
      ok: true,
      tags: { businessDomainTags: [], techStackTags: [], processTags: [] },
      costJpy: 0,
      requestId: 'req-1',
    });

    await createProject(
      {
        name: 'x',
        customerId: 'cust-1',
        purpose: 'AAA',
        background: 'BBB',
        scope: 'CCC',
        devMethod: 'waterfall',
        plannedStartDate: '2026-04-01',
        plannedEndDate: '2026-12-31',
      },
      'u-1',
      TEST_TENANT_ID,
    );

    expect(extractAutoTags).toHaveBeenCalledWith({
      purpose: 'AAA',
      background: 'BBB',
      scope: 'CCC',
      tenantId: TEST_TENANT_ID,
      userId: 'u-1',
    });
  });

  it('updateProject: text フィールドが更新対象でなければ extractAutoTags は呼ばれない (LLM 課金回避)', async () => {
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);

    await updateProject('p-1', { name: 'new name' }, 'u-1', TEST_TENANT_ID);

    expect(extractAutoTags).not.toHaveBeenCalled();
    // findUnique も呼ばれない (text 変更なし → 現行値を取りに行く必要なし)
    expect(prisma.project.findUnique).not.toHaveBeenCalled();
  });

  it('updateProject: purpose 更新時に extractAutoTags が呼ばれ、変更しない text は現行値で補完', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      purpose: 'old purpose', // 上書きされる
      background: 'EXISTING bg',
      scope: 'EXISTING sc',
      businessDomainTags: ['old-bd'],
      techStackTags: ['old-ts'],
      processTags: ['old-pr'],
    } as never);
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);
    vi.mocked(extractAutoTags).mockResolvedValueOnce({
      ok: true,
      tags: {
        businessDomainTags: ['NEW-BD'],
        techStackTags: ['NEW-TS'],
        processTags: ['NEW-PR'],
      },
      costJpy: 0,
      requestId: 'req-1',
    });

    await updateProject(
      'p-1',
      { purpose: 'NEW PURPOSE' },
      'u-1',
      TEST_TENANT_ID,
    );

    // extractAutoTags には更新後の purpose + 現行の bg/scope が渡る
    expect(extractAutoTags).toHaveBeenCalledWith({
      purpose: 'NEW PURPOSE',
      background: 'EXISTING bg',
      scope: 'EXISTING sc',
      tenantId: TEST_TENANT_ID,
      userId: 'u-1',
    });

    // 既存タグ + 新 auto タグの union が保存される
    const call = vi.mocked(prisma.project.update).mock.calls[0][0];
    expect(call.data.businessDomainTags).toEqual(['old-bd', 'NEW-BD']);
    expect(call.data.techStackTags).toEqual(['old-ts', 'NEW-TS']);
    expect(call.data.processTags).toEqual(['old-pr', 'NEW-PR']);
  });

  it('updateProject: text + tags 同時更新時、user 入力タグ + auto タグを優先 (current は使わない)', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      purpose: 'old',
      background: 'old',
      scope: 'old',
      businessDomainTags: ['old-bd'],
      techStackTags: ['old-ts'],
      processTags: ['old-pr'],
    } as never);
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);
    vi.mocked(extractAutoTags).mockResolvedValueOnce({
      ok: true,
      tags: {
        businessDomainTags: ['AUTO-BD'],
        techStackTags: [],
        processTags: [],
      },
      costJpy: 0,
      requestId: 'req-1',
    });

    await updateProject(
      'p-1',
      {
        purpose: 'NEW',
        businessDomainTags: ['USER-BD'], // user が明示的に上書き
      },
      'u-1',
      TEST_TENANT_ID,
    );

    const call = vi.mocked(prisma.project.update).mock.calls[0][0];
    // user 提供軸: ['USER-BD'] + auto ['AUTO-BD'] = 重複除去 union
    expect(call.data.businessDomainTags).toEqual(['USER-BD', 'AUTO-BD']);
    // user 非提供軸: 現行値 + auto (auto が空なので現行値のみ)
    expect(call.data.techStackTags).toEqual(['old-ts']);
    expect(call.data.processTags).toEqual(['old-pr']);
  });

  it('updateProject: text 更新 + extractAutoTags 失敗時、user 提供のみで更新 (fail-safe)', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      purpose: 'old',
      background: 'old',
      scope: 'old',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);
    vi.mocked(extractAutoTags).mockResolvedValueOnce({
      ok: false,
      reason: 'budget_exceeded',
      message: 'budget',
    });

    await updateProject(
      'p-1',
      { purpose: 'NEW', businessDomainTags: ['EC'] },
      'u-1',
      TEST_TENANT_ID,
    );

    const call = vi.mocked(prisma.project.update).mock.calls[0][0];
    expect(call.data.businessDomainTags).toEqual(['EC']);
    // text フィールドは更新される (これは独立した path)
    expect(call.data.purpose).toBe('NEW');
    // user 非提供軸はデータ未上書き (undefined)
    expect(call.data.techStackTags).toBeUndefined();
    expect(call.data.processTags).toBeUndefined();
  });

  it('updateProject: 対象プロジェクトが存在しない場合 extractAutoTags は呼ばれず、通常 update に進む', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);

    await updateProject(
      'p-missing',
      { purpose: 'NEW' },
      'u-1',
      TEST_TENANT_ID,
    );

    expect(extractAutoTags).not.toHaveBeenCalled();
    // update 自体は実行 (Prisma 側で NOT_FOUND として throw する別経路)
    expect(prisma.project.update).toHaveBeenCalled();
  });

  // ========================================================
  // PR #5 (T-03 Phase 2): embedding 生成フックの統合テスト
  // ========================================================

  it('createProject: embedding 生成成功時、persistEmbedding が呼ばれる', async () => {
    vi.mocked(prisma.project.create).mockResolvedValue(pRow() as never);
    vi.mocked(generateEmbedding).mockResolvedValueOnce({
      ok: true,
      embedding: new Array(1024).fill(0.5),
      costJpy: 0,
      requestId: 'req-emb-1',
    });

    await createProject(
      {
        name: 'x',
        customerId: 'cust-1',
        purpose: 'EC サイト構築',
        background: '既存システムの刷新',
        scope: 'フロント + 管理画面',
        devMethod: 'agile',
        plannedStartDate: '2026-04-01',
        plannedEndDate: '2026-12-31',
      },
      'u-1',
      TEST_TENANT_ID,
    );

    // generateEmbedding が project-embedding featureUnit で呼ばれる
    expect(generateEmbedding).toHaveBeenCalledTimes(1);
    const embedCall = vi.mocked(generateEmbedding).mock.calls[0]![0];
    expect(embedCall.featureUnit).toBe('project-embedding');
    expect(embedCall.tenantId).toBe(TEST_TENANT_ID);
    expect(embedCall.userId).toBe('u-1');
    // text は purpose + background + scope を改行結合
    expect(embedCall.text).toContain('EC サイト構築');
    expect(embedCall.text).toContain('既存システムの刷新');
    expect(embedCall.text).toContain('フロント + 管理画面');

    // 成功時は persistEmbedding が呼ばれる
    expect(persistEmbedding).toHaveBeenCalledTimes(1);
    expect(persistEmbedding).toHaveBeenCalledWith(
      'projects',
      'p-1',
      TEST_TENANT_ID,
      expect.arrayContaining([0.5]),
    );
  });

  it('createProject: embedding 生成失敗時 (rate_limited 等) は recordError + 本体続行 (fail-safe)', async () => {
    vi.mocked(prisma.project.create).mockResolvedValue(pRow() as never);
    vi.mocked(generateEmbedding).mockResolvedValueOnce({
      ok: false,
      reason: 'rate_limited',
      message: 'rate',
    });

    await createProject(
      {
        name: 'x',
        customerId: 'cust-1',
        purpose: 'p',
        background: 'b',
        scope: 's',
        devMethod: 'waterfall',
        plannedStartDate: '2026-04-01',
        plannedEndDate: '2026-12-31',
      },
      'u-1',
      TEST_TENANT_ID,
    );

    // persistEmbedding は呼ばれない
    expect(persistEmbedding).not.toHaveBeenCalled();
    // 失敗ログが warn 重要度で記録される
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warn',
        source: 'server',
        context: expect.objectContaining({
          kind: 'project_embedding_failure',
          projectId: 'p-1',
          reason: 'rate_limited',
        }),
      }),
    );
    // プロジェクト作成自体は成功する (本体 create は呼ばれた)
    expect(prisma.project.create).toHaveBeenCalled();
  });

  it('createProject: text が全て空文字なら embedding 呼び出しなし (LLM 課金回避)', async () => {
    vi.mocked(prisma.project.create).mockResolvedValue(pRow() as never);

    await createProject(
      {
        name: 'x',
        customerId: 'cust-1',
        purpose: '',
        background: '',
        scope: '',
        devMethod: 'waterfall',
        plannedStartDate: '2026-04-01',
        plannedEndDate: '2026-12-31',
      },
      'u-1',
      TEST_TENANT_ID,
    );

    expect(generateEmbedding).not.toHaveBeenCalled();
    expect(persistEmbedding).not.toHaveBeenCalled();
  });

  it('createProject: persistEmbedding が throw しても本体作成は成功 (recordError + 続行)', async () => {
    vi.mocked(prisma.project.create).mockResolvedValue(pRow() as never);
    vi.mocked(generateEmbedding).mockResolvedValueOnce({
      ok: true,
      embedding: new Array(1024).fill(0.1),
      costJpy: 0,
      requestId: 'req-emb-1',
    });
    vi.mocked(persistEmbedding).mockRejectedValueOnce(new Error('DB connection lost'));

    // 本体は throw せず通常通り完了
    await expect(
      createProject(
        {
          name: 'x',
          customerId: 'cust-1',
          purpose: 'p',
          background: 'b',
          scope: 's',
          devMethod: 'waterfall',
          plannedStartDate: '2026-04-01',
          plannedEndDate: '2026-12-31',
        },
        'u-1',
        TEST_TENANT_ID,
      ),
    ).resolves.toBeDefined();

    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        context: expect.objectContaining({
          kind: 'project_embedding_persist_failure',
        }),
      }),
    );
  });

  it('updateProject: text 変更なしなら embedding 呼び出しなし (LLM 課金回避)', async () => {
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);

    await updateProject('p-1', { name: 'new name' }, 'u-1', TEST_TENANT_ID);

    expect(generateEmbedding).not.toHaveBeenCalled();
    expect(persistEmbedding).not.toHaveBeenCalled();
  });

  it('updateProject: text 変更時、embedding を再生成 + persist する', async () => {
    vi.mocked(prisma.project.findUnique).mockResolvedValue({
      purpose: 'old',
      background: 'old bg',
      scope: 'old sc',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);
    vi.mocked(generateEmbedding).mockResolvedValueOnce({
      ok: true,
      embedding: new Array(1024).fill(0.7),
      costJpy: 0,
      requestId: 'req-emb-update',
    });

    await updateProject(
      'p-1',
      { purpose: 'NEW PURPOSE' },
      'u-1',
      TEST_TENANT_ID,
    );

    // generateEmbedding に新しい purpose + 現行 background/scope が渡される
    expect(generateEmbedding).toHaveBeenCalled();
    const embedCall = vi.mocked(generateEmbedding).mock.calls[0]![0];
    expect(embedCall.text).toContain('NEW PURPOSE');
    expect(embedCall.text).toContain('old bg');
    expect(embedCall.text).toContain('old sc');

    // persistEmbedding が当該 projectId + tenantId で呼ばれる
    expect(persistEmbedding).toHaveBeenCalledWith(
      'projects',
      'p-1',
      TEST_TENANT_ID,
      expect.arrayContaining([0.7]),
    );
  });

  it('deleteProject: deletedAt セット (論理削除)', async () => {
    vi.mocked(prisma.project.update).mockResolvedValue({} as never);
    // PR #89: deleteProject が task / estimate の findMany を呼ぶため事前モック
    vi.mocked(prisma.task.findMany).mockResolvedValue([]);
    vi.mocked(prisma.estimate.findMany).mockResolvedValue([]);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 0 } as never);

    await deleteProject('p-1', 'u-1');

    expect(prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
    // PR #89: 紐づく attachment も同時削除
    expect(prisma.attachment.updateMany).toHaveBeenCalled();
  });
});

describe('changeProjectStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('プロジェクト不在で NOT_FOUND', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null);
    await expect(
      changeProjectStatus('p-1', 'estimating' as never, 'u-1'),
    ).rejects.toThrow('NOT_FOUND');
  });

  it('遷移不可なら STATE_CONFLICT:理由', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(pRow({ status: 'executing' }) as never);
    vi.mocked(canTransition).mockReturnValue({ allowed: false, reason: '逆戻りは不可' });

    await expect(
      changeProjectStatus('p-1', 'planning' as never, 'u-1'),
    ).rejects.toThrow(/STATE_CONFLICT:逆戻り/);
  });

  it('遷移可能なら status 更新', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(pRow({ status: 'planning' }) as never);
    vi.mocked(canTransition).mockReturnValue({ allowed: true });
    vi.mocked(prisma.project.update).mockResolvedValue(
      pRow({ status: 'estimating' }) as never,
    );

    const r = await changeProjectStatus('p-1', 'estimating' as never, 'u-1');
    expect(r.status).toBe('estimating');
    expect(prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'estimating', updatedBy: 'u-1' }),
      }),
    );
  });
});

describe('deleteProjectCascade (PR #89: 細粒度フラグ対応)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 共通のベースラインモック (呼び出されても影響しない)
    vi.mocked(prisma.task.findMany).mockResolvedValue([]);
    vi.mocked(prisma.estimate.findMany).mockResolvedValue([]);
    vi.mocked(prisma.attachment.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.task.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.estimate.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.projectMember.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.project.delete).mockResolvedValue({} as never);
  });

  it('フラグ全て false (デフォルト): リスク/課題/振り返り/ナレッジは削除されず、本体のみ物理削除', async () => {
    const r = await deleteProjectCascade('p-1');

    expect(r.risks).toBe(0);
    expect(r.issues).toBe(0);
    expect(r.retrospectives).toBe(0);
    expect(r.knowledgeDeleted).toBe(0);
    expect(prisma.riskIssue.deleteMany).not.toHaveBeenCalled();
    expect(prisma.retrospective.deleteMany).not.toHaveBeenCalled();
    expect(prisma.knowledgeProject.findMany).not.toHaveBeenCalled();
    // 本体 + 強制削除対象 (task / estimate / projectMember / project) は実行される
    expect(prisma.project.delete).toHaveBeenCalledWith({ where: { id: 'p-1' } });
    expect(prisma.projectMember.deleteMany).toHaveBeenCalledWith({ where: { projectId: 'p-1' } });
  });

  it('cascadeRisks=true: リスク (type=risk) と添付を物理削除', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      { id: 'r-1' },
      { id: 'r-2' },
    ] as never);
    vi.mocked(prisma.riskIssue.deleteMany).mockResolvedValue({ count: 2 } as never);
    vi.mocked(prisma.attachment.deleteMany).mockResolvedValue({ count: 5 } as never);

    const r = await deleteProjectCascade('p-1', { cascadeRisks: true });

    expect(r.risks).toBe(2);
    // riskIssue.findMany は type='risk' でフィルタ
    const riskFindCall = vi.mocked(prisma.riskIssue.findMany).mock.calls[0][0];
    expect(riskFindCall.where).toEqual(expect.objectContaining({ type: 'risk' }));
    expect(prisma.attachment.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entityType: 'risk', entityId: { in: ['r-1', 'r-2'] } }),
      }),
    );
  });

  it('cascadeIssues=true: 課題 (type=issue) のみ削除 (リスクは残す)', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([{ id: 'i-1' }] as never);
    vi.mocked(prisma.riskIssue.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.attachment.deleteMany).mockResolvedValue({ count: 0 } as never);

    const r = await deleteProjectCascade('p-1', { cascadeIssues: true });

    expect(r.issues).toBe(1);
    expect(r.risks).toBe(0);
    const call = vi.mocked(prisma.riskIssue.findMany).mock.calls[0][0];
    expect(call.where).toEqual(expect.objectContaining({ type: 'issue' }));
  });

  it('cascadeRetros=true: 振り返り + コメントを物理削除', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      { id: 'ret-1' },
    ] as never);
    vi.mocked(prisma.retrospective.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.comment.deleteMany).mockResolvedValue({ count: 2 } as never);

    const r = await deleteProjectCascade('p-1', { cascadeRetros: true });

    expect(r.retrospectives).toBe(1);
    expect(prisma.comment.deleteMany).toHaveBeenCalled();
  });

  it('cascadeKnowledge=true: 他プロジェクト共有のナレッジは unlink (本体残存)', async () => {
    vi.mocked(prisma.knowledgeProject.findMany).mockResolvedValue([
      { knowledgeId: 'k-1' },
    ] as never);
    vi.mocked(prisma.knowledgeProject.count).mockResolvedValue(3);
    vi.mocked(prisma.knowledgeProject.delete).mockResolvedValue({} as never);

    const r = await deleteProjectCascade('p-1', { cascadeKnowledge: true });

    expect(r.knowledgeUnlinked).toBe(1);
    expect(r.knowledgeDeleted).toBe(0);
    expect(prisma.knowledge.delete).not.toHaveBeenCalled();
  });

  it('cascadeKnowledge=true: 単独紐付けなら本体 + attachment を物理削除', async () => {
    vi.mocked(prisma.knowledgeProject.findMany).mockResolvedValue([
      { knowledgeId: 'k-1' },
    ] as never);
    vi.mocked(prisma.knowledgeProject.count).mockResolvedValue(1);
    vi.mocked(prisma.knowledgeProject.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.knowledge.delete).mockResolvedValue({} as never);

    const r = await deleteProjectCascade('p-1', { cascadeKnowledge: true });

    expect(r.knowledgeDeleted).toBe(1);
    expect(r.knowledgeUnlinked).toBe(0);
    expect(prisma.knowledge.delete).toHaveBeenCalledWith({ where: { id: 'k-1' } });
    // knowledge の attachment も削除
    const attDeleteCalls = vi.mocked(prisma.attachment.deleteMany).mock.calls;
    expect(
      attDeleteCalls.some((c) => {
        const where = c[0]?.where;
        return where?.entityType === 'knowledge' && where?.entityId === 'k-1';
      }),
    ).toBe(true);
  });

  it('全フラグ true: すべて物理削除して count を返す', async () => {
    vi.mocked(prisma.riskIssue.findMany)
      .mockResolvedValueOnce([{ id: 'r-1' }] as never) // risk
      .mockResolvedValueOnce([{ id: 'i-1' }, { id: 'i-2' }] as never); // issue
    vi.mocked(prisma.riskIssue.deleteMany)
      .mockResolvedValueOnce({ count: 1 } as never)
      .mockResolvedValueOnce({ count: 2 } as never);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([{ id: 'ret-1' }] as never);
    vi.mocked(prisma.retrospective.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.comment.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.knowledgeProject.findMany).mockResolvedValue([]);

    const r = await deleteProjectCascade('p-1', {
      cascadeRisks: true,
      cascadeIssues: true,
      cascadeRetros: true,
      cascadeKnowledge: true,
    });

    expect(r.risks).toBe(1);
    expect(r.issues).toBe(2);
    expect(r.retrospectives).toBe(1);
  });
});
