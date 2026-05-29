import { describe, it, expect, vi, beforeEach } from 'vitest';

// feat/crud-permission-redesign (2026-05-20, 2 巡目検証 S1-D2):
//   deleteProjectCascade の強制削除セクションを interactive transaction で囲ったため、
//   $transaction が callback 形式で呼ばれた場合に tx に prismaMock を渡せるようにする。
vi.mock('@/lib/db', () => {
  const prismaMock = {
    project: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    riskIssue: { findMany: vi.fn(), deleteMany: vi.fn(), delete: vi.fn() },
    retrospective: { findMany: vi.fn(), deleteMany: vi.fn(), delete: vi.fn() },
    riskIssueProject: {
      findMany: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    retrospectiveProject: {
      findMany: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
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
    attachment: { updateMany: vi.fn(), deleteMany: vi.fn() },
    suggestionExplanation: { deleteMany: vi.fn() },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: vi.fn(async (arg: any) => {
      if (typeof arg === 'function') {
        // interactive transaction (callback): tx に prismaMock を渡す
        return arg(prismaMock);
      }
      // 配列形式
      return Promise.all(arg);
    }),
  };
  return { prisma: prismaMock };
});

vi.mock('./state-machine', () => ({
  canTransition: vi.fn(),
}));

// (2026-05-15) auto-tag + embedding を 1 ApiCallLog に集約するリファクタ後のモック構成。
//   extractTagsAndEmbedForProject (project.service 内) が withMeteredLLM の callback 内で
//   callAnthropicForAutoTagsInner + voyageEmbed を順次呼び出す。テストではこの 3 つを差し替える:
//     - withMeteredLLM: default は degraded(rate_limited) を返却 (callback 非呼出 = 旧 default の挙動と整合)
//     - callAnthropicForAutoTagsInner: default は tags: null (検証失敗相当)
//     - voyageEmbed: default は 1024 次元の dummy ベクトル返却
//     - persistEmbedding: default は 1 行更新成功
vi.mock('./auto-tag.service', () => ({
  callAnthropicForAutoTagsInner: vi.fn().mockResolvedValue({
    tags: null,
    llmInputTokens: 0,
    llmOutputTokens: 0,
  }),
}));

vi.mock('./embedding.service', () => ({
  persistEmbedding: vi.fn().mockResolvedValue(1),
}));

vi.mock('@/lib/llm/voyage-client', () => ({
  voyageEmbed: vi.fn().mockResolvedValue({
    embeddings: [new Array(1024).fill(0.5)],
    totalTokens: 10,
  }),
}));

vi.mock('@/lib/llm/metered', () => ({
  withMeteredLLM: vi.fn().mockResolvedValue({
    ok: false,
    reason: 'rate_limited',
    retryAfterSec: 60,
    message: 'default mock — テストごとに上書きする',
  }),
}));

vi.mock('@/config/llm', () => ({
  EMBEDDING_DIMENSIONS: 1024,
  LLM_RATE_LIMIT: { PER_MINUTE: 10, PER_HOUR: 60 },
  LLM_MODELS: { EMBEDDING: 'voyage-4-lite' },
  resolveCostForPlan: vi.fn().mockReturnValue(0),
  resolveModelForPlan: vi.fn().mockReturnValue('claude-haiku-4-5'),
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
import { getMockCallArg } from '@/lib/test-mock-helpers';
import { canTransition } from './state-machine';
import { callAnthropicForAutoTagsInner } from './auto-tag.service';
import { persistEmbedding } from './embedding.service';
import { voyageEmbed } from '@/lib/llm/voyage-client';
import { withMeteredLLM } from '@/lib/llm/metered';
import { recordError } from './error-log.service';

/**
 * (2026-05-15) withMeteredLLM の "成功" モック helper。
 *   - callback を実際に呼び出す (= callAnthropicForAutoTagsInner + voyageEmbed を経由)
 *   - callback の戻り値 (result) を保持し、ApiCallLog 相当の成功レスポンスを返却
 *
 * 用途: 「LLM 呼出が 1 回だけ走り、結果を取得できる」ケースを再現する。
 */
function mockMeteredLLMSuccessRunCallback() {
  vi.mocked(withMeteredLLM).mockImplementationOnce(async (_opts, call) => {
    try {
      const cb = await call({
        modelName: 'claude-haiku-4-5',
        requestId: 'req-test-merged',
      });
      return {
        ok: true,
        result: cb.result,
        costJpy: 10,
        latencyMs: 100,
        modelName: 'claude-haiku-4-5',
        requestId: 'req-test-merged',
      };
    } catch (error) {
      return {
        ok: false,
        reason: 'llm_error',
        error,
        message: error instanceof Error ? error.message : 'inner call failed',
      };
    }
  });
}

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

    await listProjects({}, 'admin-1', 'admin', 'tenant-A');

    const call = getMockCallArg(vi.mocked(prisma.project.findMany));
    expect(call.where).not.toHaveProperty('members');
    expect(call.where.tenantId).toBe('tenant-A');
  });

  it('非 admin は自身がメンバーのみ', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([]);
    vi.mocked(prisma.project.count).mockResolvedValue(0);

    await listProjects({}, 'u-1', 'general', 'tenant-A');

    const call = getMockCallArg(vi.mocked(prisma.project.findMany));
    expect(call.where.members).toEqual({ some: { userId: 'u-1' } });
    expect(call.where.tenantId).toBe('tenant-A');
  });

  it('keyword でフィルタ (name/customer.name/purpose の OR)', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([]);
    vi.mocked(prisma.project.count).mockResolvedValue(0);

    await listProjects({ keyword: 'searchword' }, 'admin-1', 'admin', 'tenant-A');

    const call = getMockCallArg(vi.mocked(prisma.project.findMany));
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

    await listProjects({ limit: 999, page: 3 }, 'admin-1', 'admin', 'tenant-A');

    const call = getMockCallArg(vi.mocked(prisma.project.findMany));
    expect(call.take).toBe(100);
    expect(call.skip).toBe(200);
  });

  it('customerName パラメータは customer.name contains でフィルタ (PR #111-2)', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([]);
    vi.mocked(prisma.project.count).mockResolvedValue(0);

    await listProjects({ customerName: 'ACME' }, 'admin-1', 'admin', 'tenant-A');

    const call = getMockCallArg(vi.mocked(prisma.project.findMany));
    expect(call.where.customer).toEqual({
      name: { contains: 'ACME', mode: 'insensitive' },
    });
  });

  it('include: customer.name を取得し DTO に載せる (PR #111-2)', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([pRow()] as never);
    vi.mocked(prisma.project.count).mockResolvedValue(1);

    const result = await listProjects({}, 'admin-1', 'admin', 'tenant-A');

    const call = getMockCallArg(vi.mocked(prisma.project.findMany));
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

    const call = getMockCallArg(vi.mocked(prisma.project.create));
    expect(call.data.status).toBe('planning');
    expect(call.data.plannedStartDate).toBeInstanceOf(Date);
    // PR #111-2: customerId を direct FK として保存
    expect(call.data.customerId).toBe('cust-1');
    expect(call.include).toEqual({ customer: { select: { name: true } } });
  });

  it('updateProject: customerId 変更は customer.connect() に変換 (PR #111-2)', async () => {
    // 2026-05-09 feedback Phase 2-2: tenant 検証用の所有確認 mock
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      purpose: 'p',
      background: 'b',
      scope: 's',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);
    await updateProject('p-1', { customerId: 'cust-new' }, 'u-1', TEST_TENANT_ID);
    const call = getMockCallArg(vi.mocked(prisma.project.update));
    expect(call.data.customer).toEqual({ connect: { id: 'cust-new' } });
    expect(call.include).toEqual({ customer: { select: { name: true } } });
  });

  it('getProject: 存在しなければ null', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null);
    expect(await getProject('x', TEST_TENANT_ID)).toBe(null);
  });

  it('updateProject: 指定フィールドのみ', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      purpose: 'p',
      background: 'b',
      scope: 's',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);
    await updateProject('p-1', { name: 'new' }, 'u-1', TEST_TENANT_ID);

    const call = getMockCallArg(vi.mocked(prisma.project.update));
    expect(call.data.name).toBe('new');
    expect(call.data.purpose).toBeUndefined();
  });

  // ========================================================
  // PR #3-b (T-03 Phase 1): 自動タグ抽出フックの統合テスト
  // ========================================================

  it('createProject: auto-tag 成功時、user-provided + auto-extracted を union で保存', async () => {
    vi.mocked(prisma.project.create).mockResolvedValue(pRow() as never);
    vi.mocked(callAnthropicForAutoTagsInner).mockResolvedValueOnce({
      tags: {
        businessDomainTags: ['EC', '物流'],
        techStackTags: ['Next.js'],
        processTags: ['設計'],
      },
      llmInputTokens: 100,
      llmOutputTokens: 50,
    });
    mockMeteredLLMSuccessRunCallback();

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

    const call = getMockCallArg(vi.mocked(prisma.project.create));
    // user の "EC" + auto の "EC" は重複除去で 1 件
    expect(call.data.businessDomainTags).toEqual(['EC', '小売', '物流']);
    // user の React + auto の Next.js は両方残る
    expect(call.data.techStackTags).toEqual(['React', 'Next.js']);
    // user 未提供 → auto のみ
    expect(call.data.processTags).toEqual(['設計']);
  });

  it('createProject: auto-tag が rate_limited 等で失敗時、user-provided のみで保存 (fail-safe)', async () => {
    vi.mocked(prisma.project.create).mockResolvedValue(pRow() as never);
    // withMeteredLLM 既定 mock = rate_limited (callback 非呼出)

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

    const call = getMockCallArg(vi.mocked(prisma.project.create));
    expect(call.data.businessDomainTags).toEqual(['EC']);
    expect(call.data.techStackTags).toEqual([]);
    expect(call.data.processTags).toEqual([]);
  });

  it('createProject: extractTagsAndEmbedForProject の内部呼出に正しい入力 (purpose/background/scope/modelName) が渡る', async () => {
    vi.mocked(prisma.project.create).mockResolvedValue(pRow() as never);
    vi.mocked(callAnthropicForAutoTagsInner).mockResolvedValueOnce({
      tags: { businessDomainTags: [], techStackTags: [], processTags: [] },
      llmInputTokens: 1,
      llmOutputTokens: 1,
    });
    mockMeteredLLMSuccessRunCallback();

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

    expect(callAnthropicForAutoTagsInner).toHaveBeenCalledWith({
      purpose: 'AAA',
      background: 'BBB',
      scope: 'CCC',
      modelName: 'claude-haiku-4-5',
    });
    // (2026-05-15) auto-tag + embedding を 1 業務操作 = 1 withMeteredLLM ラップに集約
    expect(withMeteredLLM).toHaveBeenCalledTimes(1);
    expect(getMockCallArg(vi.mocked(withMeteredLLM)).featureUnit).toBe('project-upsert');
    expect(getMockCallArg(vi.mocked(withMeteredLLM)).tenantId).toBe(TEST_TENANT_ID);
    expect(getMockCallArg(vi.mocked(withMeteredLLM)).userId).toBe('u-1');
  });

  it('updateProject: text フィールドが更新対象でなければ LLM 呼出なし (LLM 課金回避)', async () => {
    // 2026-05-09 (PR D / #20): findUnique は常に呼ぶ (実値比較で更新判定するため)。
    //   withMeteredLLM は textFieldsChanging=false なら呼ばれない (LLM 課金回避は維持)。
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      purpose: 'cur p',
      background: 'cur b',
      scope: 'cur s',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);

    await updateProject('p-1', { name: 'new name' }, 'u-1', TEST_TENANT_ID);

    expect(withMeteredLLM).not.toHaveBeenCalled();
    expect(callAnthropicForAutoTagsInner).not.toHaveBeenCalled();
    expect(voyageEmbed).not.toHaveBeenCalled();
  });

  // 2026-05-09 (PR D / #20): 実値比較ガード — input.purpose が現行値と同じなら呼ばない
  it('updateProject: input.purpose が現行値と同じなら LLM 呼出なし (#20)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      purpose: 'same purpose',
      background: 'cur b',
      scope: 'cur s',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);

    // 同一値で送信
    await updateProject('p-1', { purpose: 'same purpose' }, 'u-1', TEST_TENANT_ID);

    expect(withMeteredLLM).not.toHaveBeenCalled();
  });

  it('updateProject: purpose 更新時に LLM が呼ばれ、変更しない text は現行値で補完', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      purpose: 'old purpose', // 上書きされる
      background: 'EXISTING bg',
      scope: 'EXISTING sc',
      businessDomainTags: ['old-bd'],
      techStackTags: ['old-ts'],
      processTags: ['old-pr'],
    } as never);
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);
    vi.mocked(callAnthropicForAutoTagsInner).mockResolvedValueOnce({
      tags: {
        businessDomainTags: ['NEW-BD'],
        techStackTags: ['NEW-TS'],
        processTags: ['NEW-PR'],
      },
      llmInputTokens: 1,
      llmOutputTokens: 1,
    });
    mockMeteredLLMSuccessRunCallback();

    await updateProject(
      'p-1',
      { purpose: 'NEW PURPOSE' },
      'u-1',
      TEST_TENANT_ID,
    );

    // callAnthropicForAutoTagsInner には更新後の purpose + 現行の bg/scope が渡る
    expect(callAnthropicForAutoTagsInner).toHaveBeenCalledWith({
      purpose: 'NEW PURPOSE',
      background: 'EXISTING bg',
      scope: 'EXISTING sc',
      modelName: 'claude-haiku-4-5',
    });

    // 既存タグ + 新 auto タグの union が保存される
    const call = getMockCallArg(vi.mocked(prisma.project.update));
    expect(call.data.businessDomainTags).toEqual(['old-bd', 'NEW-BD']);
    expect(call.data.techStackTags).toEqual(['old-ts', 'NEW-TS']);
    expect(call.data.processTags).toEqual(['old-pr', 'NEW-PR']);
  });

  it('updateProject: text + tags 同時更新時、user 入力タグ + auto タグを優先 (current は使わない)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      purpose: 'old',
      background: 'old',
      scope: 'old',
      businessDomainTags: ['old-bd'],
      techStackTags: ['old-ts'],
      processTags: ['old-pr'],
    } as never);
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);
    vi.mocked(callAnthropicForAutoTagsInner).mockResolvedValueOnce({
      tags: {
        businessDomainTags: ['AUTO-BD'],
        techStackTags: [],
        processTags: [],
      },
      llmInputTokens: 1,
      llmOutputTokens: 1,
    });
    mockMeteredLLMSuccessRunCallback();

    await updateProject(
      'p-1',
      {
        purpose: 'NEW',
        businessDomainTags: ['USER-BD'], // user が明示的に上書き
      },
      'u-1',
      TEST_TENANT_ID,
    );

    const call = getMockCallArg(vi.mocked(prisma.project.update));
    // user 提供軸: ['USER-BD'] + auto ['AUTO-BD'] = 重複除去 union
    expect(call.data.businessDomainTags).toEqual(['USER-BD', 'AUTO-BD']);
    // user 非提供軸: 現行値 + auto (auto が空なので現行値のみ)
    expect(call.data.techStackTags).toEqual(['old-ts']);
    expect(call.data.processTags).toEqual(['old-pr']);
  });

  it('updateProject: text 更新 + LLM 縮退時、user 提供のみで更新 (fail-safe)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      purpose: 'old',
      background: 'old',
      scope: 'old',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);
    // withMeteredLLM 既定 mock = rate_limited / degraded
    vi.mocked(withMeteredLLM).mockResolvedValueOnce({
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

    const call = getMockCallArg(vi.mocked(prisma.project.update));
    expect(call.data.businessDomainTags).toEqual(['EC']);
    // text フィールドは更新される (これは独立した path)
    expect(call.data.purpose).toBe('NEW');
    // user 非提供軸はデータ未上書き (undefined)
    expect(call.data.techStackTags).toBeUndefined();
    expect(call.data.processTags).toBeUndefined();
  });

  it('updateProject: 対象プロジェクトが存在しない or テナント越境時は NOT_FOUND を throw (Phase 2-2)', async () => {
    // 2026-05-09 feedback Phase 2-2: 越境/不存在を NOT_FOUND として弾く設計に変更。
    //   旧仕様 (findUnique で null → そのまま update へ進む) は越境時に Prisma 側で
    //   NOT_FOUND を throw する保険があったが、明示的に service 層で先に弾く方が安全。
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);

    await expect(
      updateProject('p-missing', { purpose: 'NEW' }, 'u-1', TEST_TENANT_ID),
    ).rejects.toThrow('NOT_FOUND');

    expect(withMeteredLLM).not.toHaveBeenCalled();
    // findFirst で先に弾くため update は呼ばれない
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  // ========================================================
  // (2026-05-15) auto-tag + embedding を 1 ApiCallLog に集約する統合テスト
  // ========================================================

  it('createProject: LLM 成功時、voyageEmbed + persistEmbedding が呼ばれる', async () => {
    vi.mocked(prisma.project.create).mockResolvedValue(pRow() as never);
    vi.mocked(callAnthropicForAutoTagsInner).mockResolvedValueOnce({
      tags: { businessDomainTags: [], techStackTags: [], processTags: [] },
      llmInputTokens: 1,
      llmOutputTokens: 1,
    });
    vi.mocked(voyageEmbed).mockResolvedValueOnce({
      embeddings: [new Array(1024).fill(0.5)],
      totalTokens: 20,
    });
    mockMeteredLLMSuccessRunCallback();

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

    // (2026-05-15) auto-tag + embedding は 1 度の withMeteredLLM 内で実施 → ApiCallLog 1 件相当
    expect(withMeteredLLM).toHaveBeenCalledTimes(1);
    // voyageEmbed は purpose/background/scope を改行結合した text で呼ばれる
    expect(voyageEmbed).toHaveBeenCalledTimes(1);
    const voyageCall = getMockCallArg(vi.mocked(voyageEmbed));
    expect(voyageCall.texts[0]).toContain('EC サイト構築');
    expect(voyageCall.texts[0]).toContain('既存システムの刷新');
    expect(voyageCall.texts[0]).toContain('フロント + 管理画面');

    // 成功時は persistEmbedding が呼ばれる
    expect(persistEmbedding).toHaveBeenCalledTimes(1);
    expect(persistEmbedding).toHaveBeenCalledWith(
      'projects',
      'p-1',
      TEST_TENANT_ID,
      expect.arrayContaining([0.5]),
    );
  });

  it('createProject: LLM 縮退時 (rate_limited 等) は recordError + 本体続行 (fail-safe)', async () => {
    vi.mocked(prisma.project.create).mockResolvedValue(pRow() as never);
    // withMeteredLLM 既定 mock = rate_limited

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

    // 縮退時は persistEmbedding は呼ばれない
    expect(persistEmbedding).not.toHaveBeenCalled();
    // 失敗ログが warn 重要度で記録される
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warn',
        source: 'server',
        context: expect.objectContaining({
          kind: 'project_upsert_llm_failure',
          reason: 'rate_limited',
        }),
      }),
    );
    // プロジェクト作成自体は成功する (本体 create は呼ばれた)
    expect(prisma.project.create).toHaveBeenCalled();
  });

  it('createProject: text が全て空文字なら LLM が一切呼ばれない (withMeteredLLM 自体スキップ、課金ゼロ)', async () => {
    // (2026-05-15) 早期 return で Anthropic/Voyage 共にスキップ + withMeteredLLM も呼ばれない
    //   = ApiCallLog 0 件、Tenant counter / costJpy も増分なし。
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

    expect(withMeteredLLM).not.toHaveBeenCalled();
    expect(callAnthropicForAutoTagsInner).not.toHaveBeenCalled();
    expect(voyageEmbed).not.toHaveBeenCalled();
    expect(persistEmbedding).not.toHaveBeenCalled();
    // 本体作成自体は成功する
    expect(prisma.project.create).toHaveBeenCalled();
  });

  it('createProject: text の一部 (purpose のみ) でも非空なら LLM 呼出される (= 早期 return しない)', async () => {
    vi.mocked(prisma.project.create).mockResolvedValue(pRow() as never);
    vi.mocked(callAnthropicForAutoTagsInner).mockResolvedValueOnce({
      tags: { businessDomainTags: [], techStackTags: [], processTags: [] },
      llmInputTokens: 1,
      llmOutputTokens: 1,
    });
    mockMeteredLLMSuccessRunCallback();

    await createProject(
      {
        name: 'x',
        customerId: 'cust-1',
        purpose: 'P',
        background: '',
        scope: '',
        devMethod: 'waterfall',
        plannedStartDate: '2026-04-01',
        plannedEndDate: '2026-12-31',
      },
      'u-1',
      TEST_TENANT_ID,
    );

    expect(withMeteredLLM).toHaveBeenCalledTimes(1);
  });

  it('createProject: text が全て空白のみ (タブ/改行/全角空白) でも LLM 呼出されない', async () => {
    vi.mocked(prisma.project.create).mockResolvedValue(pRow() as never);

    await createProject(
      {
        name: 'x',
        customerId: 'cust-1',
        purpose: '   ',
        background: '\t\n',
        scope: '  ',
        devMethod: 'waterfall',
        plannedStartDate: '2026-04-01',
        plannedEndDate: '2026-12-31',
      },
      'u-1',
      TEST_TENANT_ID,
    );

    expect(withMeteredLLM).not.toHaveBeenCalled();
  });

  it('createProject: persistEmbedding が throw しても本体作成は成功 (recordError + 続行)', async () => {
    vi.mocked(prisma.project.create).mockResolvedValue(pRow() as never);
    vi.mocked(callAnthropicForAutoTagsInner).mockResolvedValueOnce({
      tags: { businessDomainTags: [], techStackTags: [], processTags: [] },
      llmInputTokens: 1,
      llmOutputTokens: 1,
    });
    vi.mocked(voyageEmbed).mockResolvedValueOnce({
      embeddings: [new Array(1024).fill(0.1)],
      totalTokens: 10,
    });
    vi.mocked(persistEmbedding).mockRejectedValueOnce(new Error('DB connection lost'));
    mockMeteredLLMSuccessRunCallback();

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

  it('updateProject: text 変更なしなら voyageEmbed / persistEmbedding 呼出なし (LLM 課金回避)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      purpose: 'p',
      background: 'b',
      scope: 's',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);

    await updateProject('p-1', { name: 'new name' }, 'u-1', TEST_TENANT_ID);

    expect(withMeteredLLM).not.toHaveBeenCalled();
    expect(voyageEmbed).not.toHaveBeenCalled();
    expect(persistEmbedding).not.toHaveBeenCalled();
  });

  it('updateProject: text 変更時、voyageEmbed + persistEmbedding が呼ばれる', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      purpose: 'old',
      background: 'old bg',
      scope: 'old sc',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.project.update).mockResolvedValue(pRow() as never);
    vi.mocked(callAnthropicForAutoTagsInner).mockResolvedValueOnce({
      tags: { businessDomainTags: [], techStackTags: [], processTags: [] },
      llmInputTokens: 1,
      llmOutputTokens: 1,
    });
    vi.mocked(voyageEmbed).mockResolvedValueOnce({
      embeddings: [new Array(1024).fill(0.7)],
      totalTokens: 20,
    });
    mockMeteredLLMSuccessRunCallback();

    await updateProject(
      'p-1',
      { purpose: 'NEW PURPOSE' },
      'u-1',
      TEST_TENANT_ID,
    );

    // voyageEmbed に新しい purpose + 現行 background/scope が渡される
    expect(voyageEmbed).toHaveBeenCalled();
    const voyageCall = getMockCallArg(vi.mocked(voyageEmbed));
    expect(voyageCall.texts[0]).toContain('NEW PURPOSE');
    expect(voyageCall.texts[0]).toContain('old bg');
    expect(voyageCall.texts[0]).toContain('old sc');

    // persistEmbedding が当該 projectId + tenantId で呼ばれる
    expect(persistEmbedding).toHaveBeenCalledWith(
      'projects',
      'p-1',
      TEST_TENANT_ID,
      expect.arrayContaining([0.7]),
    );
  });

  it('(2026-05-15) createProject: 1 業務操作で withMeteredLLM ラップは 1 度だけ (ApiCallLog 1 件相当)', async () => {
    // 旧仕様 (auto-tag-extract + project-embedding 各別ラップ) では 2 度呼ばれていた。
    // 新仕様 (extractTagsAndEmbedForProject) では 1 度のみで auto-tag + embedding を統合。
    vi.mocked(prisma.project.create).mockResolvedValue(pRow() as never);
    vi.mocked(callAnthropicForAutoTagsInner).mockResolvedValueOnce({
      tags: { businessDomainTags: [], techStackTags: [], processTags: [] },
      llmInputTokens: 1,
      llmOutputTokens: 1,
    });
    mockMeteredLLMSuccessRunCallback();

    await createProject(
      {
        name: 'x',
        customerId: 'cust-1',
        purpose: 'P',
        background: 'B',
        scope: 'S',
        devMethod: 'waterfall',
        plannedStartDate: '2026-04-01',
        plannedEndDate: '2026-12-31',
      },
      'u-1',
      TEST_TENANT_ID,
    );

    expect(withMeteredLLM).toHaveBeenCalledTimes(1);
  });

  it('deleteProject: deletedAt セット (論理削除)', async () => {
    // 2026-05-09 feedback Phase 2-2: 冒頭の所有確認用 mock
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'p-1' } as never);
    vi.mocked(prisma.project.update).mockResolvedValue({} as never);
    // PR #89: deleteProject が task / estimate の findMany を呼ぶため事前モック
    vi.mocked(prisma.task.findMany).mockResolvedValue([]);
    vi.mocked(prisma.estimate.findMany).mockResolvedValue([]);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 0 } as never);

    await deleteProject('p-1', 'u-1', TEST_TENANT_ID);

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
      changeProjectStatus('p-1', 'estimating' as never, 'u-1', TEST_TENANT_ID),
    ).rejects.toThrow('NOT_FOUND');
  });

  it('遷移不可なら STATE_CONFLICT:理由', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(pRow({ status: 'executing' }) as never);
    vi.mocked(canTransition).mockReturnValue({ allowed: false, reason: '逆戻りは不可' });

    await expect(
      changeProjectStatus('p-1', 'planning' as never, 'u-1', TEST_TENANT_ID),
    ).rejects.toThrow(/STATE_CONFLICT:逆戻り/);
  });

  it('遷移可能なら status 更新', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(pRow({ status: 'planning' }) as never);
    vi.mocked(canTransition).mockReturnValue({ allowed: true });
    vi.mocked(prisma.project.update).mockResolvedValue(
      pRow({ status: 'estimating' }) as never,
    );

    const r = await changeProjectStatus('p-1', 'estimating' as never, 'u-1', TEST_TENANT_ID);
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
    // 2026-05-09 feedback Phase 2-2: 冒頭の所有確認用 mock (越境カスケード遮断)
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'p-1' } as never);
    // 共通のベースラインモック (呼び出されても影響しない)
    vi.mocked(prisma.task.findMany).mockResolvedValue([]);
    vi.mocked(prisma.estimate.findMany).mockResolvedValue([]);
    vi.mocked(prisma.attachment.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.task.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.estimate.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.projectMember.deleteMany).mockResolvedValue({ count: 0 } as never);
    // 2026-05-09 hotfix: SuggestionExplanation cleanup
    vi.mocked(prisma.suggestionExplanation.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.project.delete).mockResolvedValue({} as never);
  });

  it('フラグ全て false (デフォルト): リスク/課題/振り返り/ナレッジは削除されず、本体のみ物理削除', async () => {
    const r = await deleteProjectCascade('p-1', TEST_TENANT_ID);

    expect(r.risks).toBe(0);
    expect(r.issues).toBe(0);
    expect(r.retrospectives).toBe(0);
    expect(r.knowledgeDeleted).toBe(0);
    expect(prisma.riskIssue.deleteMany).not.toHaveBeenCalled();
    expect(prisma.retrospective.deleteMany).not.toHaveBeenCalled();
    expect(prisma.knowledgeProject.findMany).not.toHaveBeenCalled();
    // 本体 + 強制削除対象 (task / estimate / projectMember / project) は実行される
    expect(prisma.project.delete).toHaveBeenCalledWith({ where: { id: 'p-1' } });
    // 2026-05-12 severity-1 防御: projectMember.deleteMany にも project.tenantId 検証を併記
    expect(prisma.projectMember.deleteMany).toHaveBeenCalledWith({
      where: { projectId: 'p-1', project: { tenantId: TEST_TENANT_ID } },
    });
  });

  // 2026-05-09 hotfix: project.delete 前に SuggestionExplanation を必ず deleteMany する
  //   (FK suggestion_explanations_project_id_fkey の P2003 を回避)。本番障害の再現防止。
  // 2026-05-12: severity-1 防御として tenantId を where に明示
  it('project.delete 前に SuggestionExplanation を必ず削除する (#hotfix)', async () => {
    await deleteProjectCascade('p-1', TEST_TENANT_ID);

    expect(prisma.suggestionExplanation.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: TEST_TENANT_ID, projectId: 'p-1' },
    });
  });

  // 2026-05-12 severity-1 防御: cascade 削除の各 deleteMany が tenantId を持つことを検証
  it('cascade 削除の全 deleteMany に tenantId が含まれる (defense-in-depth)', async () => {
    await deleteProjectCascade('p-1', TEST_TENANT_ID);

    // task / estimate / projectMember は project relation 経由
    expect(prisma.task.deleteMany).toHaveBeenCalledWith({
      where: { projectId: 'p-1', project: { tenantId: TEST_TENANT_ID } },
    });
    expect(prisma.estimate.deleteMany).toHaveBeenCalledWith({
      where: { projectId: 'p-1', project: { tenantId: TEST_TENANT_ID } },
    });
    // attachment は tenantId 列を持つので直接フィルタ
    expect(prisma.attachment.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: TEST_TENANT_ID, entityType: 'project', entityId: 'p-1' },
    });
  });

  // PR feat/asset-multi-project-linking: 新仕様 = Knowledge と同型の M:N 経由カスケード
  //   linkCount > 1 → unlink のみ / linkCount = 1 → 本体物理削除
  it('cascadeRisks=true (単独紐付け): 本体 + 添付 + コメントを物理削除', async () => {
    vi.mocked(prisma.riskIssueProject.findMany).mockResolvedValue([
      { riskIssueId: 'r-1' },
      { riskIssueId: 'r-2' },
    ] as never);
    // 各 risk の linkCount = 1 (この project 以外の参照なし) → 物理削除
    vi.mocked(prisma.riskIssueProject.count).mockResolvedValue(1);
    vi.mocked(prisma.riskIssueProject.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.riskIssue.delete).mockResolvedValue({} as never);
    vi.mocked(prisma.attachment.deleteMany).mockResolvedValue({ count: 5 } as never);

    const r = await deleteProjectCascade('p-1', TEST_TENANT_ID, { cascadeRisks: true });

    expect(r.risks).toBe(2);
    // findMany は projectId + type='risk' で絞り込み
    const findCall = getMockCallArg(vi.mocked(prisma.riskIssueProject.findMany));
    expect(findCall.where).toEqual({ projectId: 'p-1', riskIssue: { type: 'risk' } });
    // 本体 delete が 2 件分呼ばれる
    expect(prisma.riskIssue.delete).toHaveBeenCalledTimes(2);
  });

  it('cascadeRisks=true (他プロジェクト参照あり): 本体は残し M:N 行のみ削除 (unlink)', async () => {
    vi.mocked(prisma.riskIssueProject.findMany).mockResolvedValue([
      { riskIssueId: 'r-1' },
    ] as never);
    // linkCount = 2 → unlink のみ
    vi.mocked(prisma.riskIssueProject.count).mockResolvedValue(2);
    vi.mocked(prisma.riskIssueProject.delete).mockResolvedValue({} as never);

    const r = await deleteProjectCascade('p-1', TEST_TENANT_ID, { cascadeRisks: true });

    expect(r.risks).toBe(0); // 本体は削除されていない
    // 単独 unlink delete が呼ばれる
    expect(prisma.riskIssueProject.delete).toHaveBeenCalledWith({
      where: { riskIssueId_projectId: { riskIssueId: 'r-1', projectId: 'p-1' } },
    });
    expect(prisma.riskIssue.delete).not.toHaveBeenCalled();
  });

  it('cascadeIssues=true (単独紐付け): 課題本体を物理削除', async () => {
    vi.mocked(prisma.riskIssueProject.findMany).mockResolvedValue([
      { riskIssueId: 'i-1' },
    ] as never);
    vi.mocked(prisma.riskIssueProject.count).mockResolvedValue(1);
    vi.mocked(prisma.riskIssueProject.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.riskIssue.delete).mockResolvedValue({} as never);

    const r = await deleteProjectCascade('p-1', TEST_TENANT_ID, { cascadeIssues: true });

    expect(r.issues).toBe(1);
    expect(r.risks).toBe(0);
    const findCall = getMockCallArg(vi.mocked(prisma.riskIssueProject.findMany));
    expect(findCall.where).toEqual({ projectId: 'p-1', riskIssue: { type: 'issue' } });
  });

  it('cascadeRetros=true (単独紐付け): 振り返り本体 + コメントを物理削除', async () => {
    vi.mocked(prisma.retrospectiveProject.findMany).mockResolvedValue([
      { retrospectiveId: 'ret-1' },
    ] as never);
    vi.mocked(prisma.retrospectiveProject.count).mockResolvedValue(1);
    vi.mocked(prisma.retrospectiveProject.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.retrospective.delete).mockResolvedValue({} as never);
    vi.mocked(prisma.comment.deleteMany).mockResolvedValue({ count: 2 } as never);

    const r = await deleteProjectCascade('p-1', TEST_TENANT_ID, { cascadeRetros: true });

    expect(r.retrospectives).toBe(1);
    expect(prisma.comment.deleteMany).toHaveBeenCalled();
    expect(prisma.retrospective.delete).toHaveBeenCalledWith({ where: { id: 'ret-1' } });
  });

  it('cascadeRetros=true (他プロジェクト参照あり): 本体は残し unlink', async () => {
    vi.mocked(prisma.retrospectiveProject.findMany).mockResolvedValue([
      { retrospectiveId: 'ret-1' },
    ] as never);
    vi.mocked(prisma.retrospectiveProject.count).mockResolvedValue(2);
    vi.mocked(prisma.retrospectiveProject.delete).mockResolvedValue({} as never);

    const r = await deleteProjectCascade('p-1', TEST_TENANT_ID, { cascadeRetros: true });

    expect(r.retrospectives).toBe(0);
    expect(prisma.retrospective.delete).not.toHaveBeenCalled();
    expect(prisma.retrospectiveProject.delete).toHaveBeenCalled();
  });

  it('cascadeKnowledge=true: 他プロジェクト共有のナレッジは unlink (本体残存)', async () => {
    vi.mocked(prisma.knowledgeProject.findMany).mockResolvedValue([
      { knowledgeId: 'k-1' },
    ] as never);
    vi.mocked(prisma.knowledgeProject.count).mockResolvedValue(3);
    vi.mocked(prisma.knowledgeProject.delete).mockResolvedValue({} as never);

    const r = await deleteProjectCascade('p-1', TEST_TENANT_ID, { cascadeKnowledge: true });

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

    const r = await deleteProjectCascade('p-1', TEST_TENANT_ID, { cascadeKnowledge: true });

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

  it('全フラグ true: 単独紐付けは物理削除、共有資産は unlink (Knowledge と同型)', async () => {
    // PR feat/asset-multi-project-linking: 全 asset 種類で M:N + linkCount 判定
    vi.mocked(prisma.riskIssueProject.findMany)
      .mockResolvedValueOnce([{ riskIssueId: 'r-1' }] as never) // type=risk
      .mockResolvedValueOnce([{ riskIssueId: 'i-1' }, { riskIssueId: 'i-2' }] as never); // type=issue
    vi.mocked(prisma.riskIssueProject.count).mockResolvedValue(1); // すべて単独紐付け
    vi.mocked(prisma.riskIssueProject.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.riskIssue.delete).mockResolvedValue({} as never);

    vi.mocked(prisma.retrospectiveProject.findMany).mockResolvedValue([
      { retrospectiveId: 'ret-1' },
    ] as never);
    vi.mocked(prisma.retrospectiveProject.count).mockResolvedValue(1);
    vi.mocked(prisma.retrospectiveProject.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.retrospective.delete).mockResolvedValue({} as never);

    vi.mocked(prisma.comment.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.knowledgeProject.findMany).mockResolvedValue([]);

    const r = await deleteProjectCascade('p-1', TEST_TENANT_ID, {
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
