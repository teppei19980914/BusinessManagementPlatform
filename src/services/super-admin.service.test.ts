/**
 * super_admin サービスの単体テスト
 *
 * 検証項目:
 *   - listMonthlyUsageHistory (P-5b): 過去 N ヶ月の yearMonth を生成して history を取得
 *   - listDormantTenants (P-6): 90 日以上活動のないテナントの抽出
 *   - DTO 整形
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    tenantMonthlyUsageHistory: {
      findMany: vi.fn(),
    },
    // P-6 (2026-05-08): listDormantTenants で使用
    tenant: {
      findMany: vi.fn(),
      // P-A (2026-05-08): deleteTenant で使用
      findUnique: vi.fn(),
      update: vi.fn(),
      // 2026-05-11: getCrossTenantUsageSummary / getDefaultTenantOwnSummary で使用
      findFirst: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
      groupBy: vi.fn(),
    },
    user: {
      groupBy: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
      // 2026-05-09 (#18): purgeOldDeletedTenants で削除すべきでない (regression test 用)
      deleteMany: vi.fn(),
    },
    // P-A: カスケード論理削除対象 (deletedAt カラム持ち)
    project: { updateMany: vi.fn(), deleteMany: vi.fn() },
    knowledge: { updateMany: vi.fn(), deleteMany: vi.fn() },
    riskIssue: { updateMany: vi.fn(), deleteMany: vi.fn() },
    retrospective: { updateMany: vi.fn(), deleteMany: vi.fn() },
    memo: { updateMany: vi.fn(), deleteMany: vi.fn() },
    stakeholder: { updateMany: vi.fn(), deleteMany: vi.fn() },
    comment: { updateMany: vi.fn(), deleteMany: vi.fn() },
    attachment: { updateMany: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn() },
    // 2026-05-09 (PR E / #12 #14): Voyage / Anthropic 集計で使用
    apiCallLog: { aggregate: vi.fn() },
    // 2026-05-09 (PR F / #18): purgeOldDeletedTenants で参照する追加テーブル
    mention: { deleteMany: vi.fn() },
    knowledgeProject: { deleteMany: vi.fn() },
    taskKnowledge: { deleteMany: vi.fn() },
    taskProgressLog: { deleteMany: vi.fn() },
    task: { deleteMany: vi.fn() },
    estimate: { deleteMany: vi.fn() },
    projectMember: { deleteMany: vi.fn() },
    customer: { deleteMany: vi.fn() },
    tenantImportPreview: { deleteMany: vi.fn() },
    suggestionExplanation: { deleteMany: vi.fn() },
    // P-A: $transaction はモックの戻り値配列をそのまま resolve する想定
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

import {
  listMonthlyUsageHistory,
  listDormantTenants,
  DORMANT_TENANT_THRESHOLD_DAYS,
  deleteTenant,
  // 2026-05-09 (PR E)
  getVoyageUsageSummary,
  getAnthropicUsageSummary,
  getBeginnerUsageSummary,
  // 2026-05-09 (PR F / #18)
  purgeOldDeletedTenants,
  // 2026-05-11: 顧客集計 + Default テナント個別取得
  getCrossTenantUsageSummary,
  getDefaultTenantOwnSummary,
} from './super-admin.service';
import { prisma } from '@/lib/db';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listMonthlyUsageHistory (P-5b / 2026-05-08)', () => {
  it('履歴行をテナント情報と結合して DTO 形式で返す', async () => {
    vi.mocked(prisma.tenantMonthlyUsageHistory.findMany).mockResolvedValueOnce([
      {
        yearMonth: '2026-04',
        tenantId: 'tenant-a',
        plan: 'expert',
        apiCallCount: 250,
        apiCostJpy: 2500,
        activeUserCount: 4,
        // Storage add-on (Phase 2): スナップショット時点の値
        storageBytesUsed: BigInt(50 * 1024 * 1024),
        storageAddonPlan: 'standard',
        storageAddonJpy: 0,
        totalJpy: 2500,
        tenant: { tenantSeq: 2, name: 'カスタマーA' },
      },
      {
        yearMonth: '2026-04',
        tenantId: 'tenant-b',
        plan: 'pro',
        apiCallCount: 1500,
        apiCostJpy: 45000,
        activeUserCount: 12,
        storageBytesUsed: BigInt(800 * 1024 * 1024),
        storageAddonPlan: 'plus',
        storageAddonJpy: 500,
        totalJpy: 45500,
        tenant: { tenantSeq: 3, name: 'カスタマーB' },
      },
    ] as never);

    const rows = await listMonthlyUsageHistory(6);

    expect(rows).toEqual([
      {
        yearMonth: '2026-04',
        tenantId: 'tenant-a',
        tenantSeq: 2,
        tenantName: 'カスタマーA',
        plan: 'expert',
        apiCallCount: 250,
        apiCostJpy: 2500,
        activeUserCount: 4,
        storageBytesUsed: 50 * 1024 * 1024,
        storageAddonPlan: 'standard',
        storageAddonJpy: 0,
        totalJpy: 2500,
      },
      {
        yearMonth: '2026-04',
        tenantId: 'tenant-b',
        tenantSeq: 3,
        tenantName: 'カスタマーB',
        plan: 'pro',
        apiCallCount: 1500,
        apiCostJpy: 45000,
        activeUserCount: 12,
        storageBytesUsed: 800 * 1024 * 1024,
        storageAddonPlan: 'plus',
        storageAddonJpy: 500,
        totalJpy: 45500,
      },
    ]);
  });

  it('months=6 で過去 6 ヶ月の yearMonth を IN 句に渡す (当月含まない)', async () => {
    vi.mocked(prisma.tenantMonthlyUsageHistory.findMany).mockResolvedValueOnce([] as never);

    await listMonthlyUsageHistory(6);

    const callArg = vi.mocked(prisma.tenantMonthlyUsageHistory.findMany).mock.calls[0]![0];
    const targetYearMonths = (callArg as { where: { yearMonth: { in: string[] } } })
      .where.yearMonth.in;
    // 過去 6 ヶ月分 (当月含まず) = 6 件
    expect(targetYearMonths).toHaveLength(6);
    // 全要素が "YYYY-MM" 形式
    targetYearMonths.forEach((ym) => {
      expect(ym).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    });
  });

  it('months 引数のクランプ: 0 以下なら 1 件、25 以上なら 24 件', async () => {
    vi.mocked(prisma.tenantMonthlyUsageHistory.findMany).mockResolvedValue([] as never);

    await listMonthlyUsageHistory(0);
    let callArg = vi.mocked(prisma.tenantMonthlyUsageHistory.findMany).mock.calls.at(-1)![0];
    let in1 = (callArg as { where: { yearMonth: { in: string[] } } }).where.yearMonth.in;
    expect(in1).toHaveLength(1);

    await listMonthlyUsageHistory(-5);
    callArg = vi.mocked(prisma.tenantMonthlyUsageHistory.findMany).mock.calls.at(-1)![0];
    in1 = (callArg as { where: { yearMonth: { in: string[] } } }).where.yearMonth.in;
    expect(in1).toHaveLength(1);

    await listMonthlyUsageHistory(100);
    callArg = vi.mocked(prisma.tenantMonthlyUsageHistory.findMany).mock.calls.at(-1)![0];
    in1 = (callArg as { where: { yearMonth: { in: string[] } } }).where.yearMonth.in;
    expect(in1).toHaveLength(24);
  });

  it('履歴 0 件なら空配列', async () => {
    vi.mocked(prisma.tenantMonthlyUsageHistory.findMany).mockResolvedValueOnce([] as never);

    const rows = await listMonthlyUsageHistory(6);
    expect(rows).toEqual([]);
  });
});

describe('listDormantTenants (P-6 / 2026-05-08)', () => {
  // 固定された "今" を使ってテストの再現性を確保
  const NOW = new Date('2026-05-08T12:00:00Z');
  const day = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

  it('閾値 (90 日) 内に最終ログインがあったテナントは除外される', async () => {
    // tenant-a (60 日前ログイン) は活動中、tenant-b (100 日前) は休眠
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      { id: 'tenant-a', tenantSeq: 2, name: '活動中', plan: 'expert', createdAt: day(200) },
      { id: 'tenant-b', tenantSeq: 3, name: '休眠中', plan: 'beginner', createdAt: day(200) },
    ] as never);
    vi.mocked(prisma.user.groupBy).mockResolvedValueOnce([
      { tenantId: 'tenant-a', _max: { lastLoginAt: day(60) } },
      { tenantId: 'tenant-b', _max: { lastLoginAt: day(100) } },
    ] as never);

    const rows = await listDormantTenants(90, NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('tenant-b');
    expect(rows[0]?.daysSinceLastActivity).toBe(100);
  });

  it('テナント内全員が一度もログインしていなければ createdAt 起点で判定', async () => {
    // tenant-c は 200 日前作成 + 誰もログイン未経験 → 休眠 200 日
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      { id: 'tenant-c', tenantSeq: 5, name: '無活動', plan: 'beginner', createdAt: day(200) },
    ] as never);
    vi.mocked(prisma.user.groupBy).mockResolvedValueOnce([
      { tenantId: 'tenant-c', _max: { lastLoginAt: null } },
    ] as never);

    const rows = await listDormantTenants(90, NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastUserLoginAt).toBeNull();
    expect(rows[0]?.daysSinceLastActivity).toBe(200);
  });

  it('新規 onboarding 期間 (createdAt が閾値内) は休眠判定対象外', async () => {
    // tenant-d は 30 日前作成 (= onboarding 中) → findMany の段階で除外される想定
    // findMany の where が createdAt: { lte: cutoffDate } を含むので、Prisma が事前に弾く
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([] as never);

    const rows = await listDormantTenants(90, NOW);

    expect(rows).toHaveLength(0);
    // findMany の where に createdAt の制約が入る (onboarding 期間除外)
    const callArg = vi.mocked(prisma.tenant.findMany).mock.calls[0]![0];
    expect(callArg).toMatchObject({
      where: expect.objectContaining({
        createdAt: expect.objectContaining({ lte: expect.any(Date) }),
      }),
    });
  });

  // 2026-05-09 (PR E / #19): 管理テナント + default テナントを除外
  it('管理テナント + default テナントを除外する (id notIn MANAGEMENT/DEFAULT)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([] as never);

    await listDormantTenants(90, NOW);

    const callArg = vi.mocked(prisma.tenant.findMany).mock.calls[0]![0];
    expect(callArg).toMatchObject({
      where: expect.objectContaining({
        id: {
          notIn: [
            '00000000-0000-0000-0000-ffffffffffff',
            '00000000-0000-0000-0000-000000000001',
          ],
        },
        deletedAt: null,
      }),
    });
  });

  it('複数の休眠テナントは休眠日数降順で並ぶ', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      { id: 'tenant-a', tenantSeq: 2, name: '100日休眠', plan: 'expert', createdAt: day(200) },
      { id: 'tenant-b', tenantSeq: 3, name: '300日休眠', plan: 'beginner', createdAt: day(400) },
      { id: 'tenant-c', tenantSeq: 4, name: '150日休眠', plan: 'pro', createdAt: day(200) },
    ] as never);
    vi.mocked(prisma.user.groupBy).mockResolvedValueOnce([
      { tenantId: 'tenant-a', _max: { lastLoginAt: day(100) } },
      { tenantId: 'tenant-b', _max: { lastLoginAt: day(300) } },
      { tenantId: 'tenant-c', _max: { lastLoginAt: day(150) } },
    ] as never);

    const rows = await listDormantTenants(90, NOW);

    expect(rows.map((r) => r.name)).toEqual(['300日休眠', '150日休眠', '100日休眠']);
  });

  it('対象テナント 0 件なら空配列 (user.groupBy 呼ばない)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([] as never);

    const rows = await listDormantTenants(90, NOW);

    expect(rows).toEqual([]);
    expect(prisma.user.groupBy).not.toHaveBeenCalled();
  });

  it('しきい値カスタマイズ: 30 日でも休眠判定可能', async () => {
    // 60 日前ログインのテナントは 90 日基準では活動中だが、30 日基準では休眠
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      { id: 'tenant-a', tenantSeq: 2, name: '60日休眠', plan: 'expert', createdAt: day(200) },
    ] as never);
    vi.mocked(prisma.user.groupBy).mockResolvedValueOnce([
      { tenantId: 'tenant-a', _max: { lastLoginAt: day(60) } },
    ] as never);

    const rows = await listDormantTenants(30, NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.daysSinceLastActivity).toBe(60);
  });

  it('DORMANT_TENANT_THRESHOLD_DAYS は 90 日', () => {
    expect(DORMANT_TENANT_THRESHOLD_DAYS).toBe(90);
  });
});

describe('deleteTenant (P-A / 2026-05-08)', () => {
  const TENANT_ID = '00000000-0000-0000-0000-000000000abc';
  const PERFORMER_ID = 'super-admin-uuid';
  const MANAGEMENT_TENANT_ID_VALUE = '00000000-0000-0000-0000-ffffffffffff';

  function setupHappyPathMocks() {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
      id: TENANT_ID,
      deletedAt: null,
      name: 'テスト顧客',
    } as never);

    // 各 updateMany / update / create の mock
    const mkRes = (count: number) => ({ count });
    vi.mocked(prisma.user.updateMany).mockResolvedValueOnce(mkRes(3) as never);
    vi.mocked(prisma.project.updateMany).mockResolvedValueOnce(mkRes(2) as never);
    vi.mocked(prisma.knowledge.updateMany).mockResolvedValueOnce(mkRes(10) as never);
    vi.mocked(prisma.riskIssue.updateMany).mockResolvedValueOnce(mkRes(5) as never);
    vi.mocked(prisma.retrospective.updateMany).mockResolvedValueOnce(mkRes(4) as never);
    vi.mocked(prisma.memo.updateMany).mockResolvedValueOnce(mkRes(7) as never);
    vi.mocked(prisma.stakeholder.updateMany).mockResolvedValueOnce(mkRes(2) as never);
    vi.mocked(prisma.comment.updateMany).mockResolvedValueOnce(mkRes(15) as never);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValueOnce(mkRes(8) as never);
    vi.mocked(prisma.tenant.update).mockResolvedValueOnce({} as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValueOnce({} as never);
  }

  it('正常系: 全配下エンティティに deletedAt を set し件数サマリを返す', async () => {
    setupHappyPathMocks();

    const result = await deleteTenant(TENANT_ID, PERFORMER_ID);

    expect(result.tenantId).toBe(TENANT_ID);
    expect(result.deletedCounts).toEqual({
      users: 3,
      projects: 2,
      knowledges: 10,
      risksIssues: 5,
      retrospectives: 4,
      memos: 7,
      stakeholders: 2,
      comments: 15,
      attachments: 8,
    });

    // ユーザは isActive=false も併せて更新
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_ID, deletedAt: null },
        data: expect.objectContaining({ isActive: false }),
      }),
    );

    // 監査ログが残る
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: PERFORMER_ID,
          action: 'DELETE',
          entityType: 'tenant',
          entityId: TENANT_ID,
        }),
      }),
    );
  });

  it('管理テナント (MANAGEMENT_TENANT_ID) を削除しようとすると MANAGEMENT_TENANT_FORBIDDEN', async () => {
    await expect(deleteTenant(MANAGEMENT_TENANT_ID_VALUE, PERFORMER_ID)).rejects.toThrow(
      'MANAGEMENT_TENANT_FORBIDDEN',
    );
    // findUnique も呼ばれない (= 早期 return)
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it('テナント不在なら TENANT_NOT_FOUND', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce(null);

    await expect(deleteTenant(TENANT_ID, PERFORMER_ID)).rejects.toThrow('TENANT_NOT_FOUND');

    // updateMany は呼ばれない
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('既に削除済みテナントは ALREADY_DELETED (冪等性ではなく明示エラー)', async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({
      id: TENANT_ID,
      deletedAt: new Date('2026-04-01'),
      name: '削除済',
    } as never);

    await expect(deleteTenant(TENANT_ID, PERFORMER_ID)).rejects.toThrow('ALREADY_DELETED');
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('単一 transaction で実行 ($transaction 1 回呼出)', async () => {
    setupHappyPathMocks();

    await deleteTenant(TENANT_ID, PERFORMER_ID);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // 11 オペ: users, projects, knowledges, risksIssues, retrospectives,
    // memos, stakeholders, comments, attachments, tenant.update, auditLog.create
    const txArg = vi.mocked(prisma.$transaction).mock.calls[0]![0] as unknown as unknown[];
    expect(txArg).toHaveLength(11);
  });

  it('既に user.deletedAt がセット済みの user は更新対象外 (where: deletedAt: null)', async () => {
    setupHappyPathMocks();

    await deleteTenant(TENANT_ID, PERFORMER_ID);

    // user.updateMany の where に deletedAt: null が含まれることを確認
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_ID, deletedAt: null },
      }),
    );
    // project も同じ
    expect(prisma.project.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_ID, deletedAt: null },
      }),
    );
  });
});

// ================================================================
// 2026-05-09 (PR E coverage 補強): Voyage / Anthropic / Beginner サマリ
// ================================================================

describe('getVoyageUsageSummary (PR E / #12)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('当月 embedding token を集計し ok ステータスを返す (< 80%)', async () => {
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValueOnce({
      _sum: { embeddingTokens: BigInt(1_000_000) },
    } as never);

    const r = await getVoyageUsageSummary();

    expect(r.currentMonthTokens).toBe(1_000_000);
    expect(r.freeTierTokens).toBe(200_000_000);
    expect(r.utilizationRatio).toBeLessThan(0.8);
    expect(r.status).toBe('ok');
  });

  it('80% 超で warn ステータス', async () => {
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValueOnce({
      _sum: { embeddingTokens: BigInt(170_000_000) }, // 85%
    } as never);

    const r = await getVoyageUsageSummary();
    expect(r.status).toBe('warn');
  });

  it('100% 超で alert ステータス', async () => {
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValueOnce({
      _sum: { embeddingTokens: BigInt(210_000_000) },
    } as never);

    const r = await getVoyageUsageSummary();
    expect(r.status).toBe('alert');
  });

  it('embedding 使用ゼロ時は 0 / ok を返す', async () => {
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValueOnce({
      _sum: { embeddingTokens: null },
    } as never);

    const r = await getVoyageUsageSummary();
    expect(r.currentMonthTokens).toBe(0);
    expect(r.utilizationRatio).toBe(0);
    expect(r.status).toBe('ok');
  });

  it('management + default tenant を notIn で除外する (#19)', async () => {
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValueOnce({
      _sum: { embeddingTokens: BigInt(0) },
    } as never);

    await getVoyageUsageSummary();

    const callArg = vi.mocked(prisma.apiCallLog.aggregate).mock.calls[0]![0];
    expect(callArg.where).toMatchObject({
      tenantId: {
        notIn: [
          '00000000-0000-0000-0000-ffffffffffff',
          '00000000-0000-0000-0000-000000000001',
        ],
      },
    });
  });
});

describe('getAnthropicUsageSummary (PR E / #14)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('input/output トークン + 呼出回数 + 内部請求額を返す', async () => {
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValueOnce({
      _sum: {
        llmInputTokens: BigInt(50000),
        llmOutputTokens: BigInt(20000),
        costJpy: 1500,
      },
      _count: { id: 42 },
    } as never);

    const r = await getAnthropicUsageSummary();

    expect(r.currentMonthInputTokens).toBe(50000);
    expect(r.currentMonthOutputTokens).toBe(20000);
    expect(r.currentMonthCallCount).toBe(42);
    expect(r.currentMonthInternalCostJpy).toBe(1500);
  });

  it('ゼロ呼出時は 0 でフォールバック', async () => {
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValueOnce({
      _sum: { llmInputTokens: null, llmOutputTokens: null, costJpy: null },
      _count: { id: 0 },
    } as never);

    const r = await getAnthropicUsageSummary();
    expect(r.currentMonthInputTokens).toBe(0);
    expect(r.currentMonthOutputTokens).toBe(0);
    expect(r.currentMonthInternalCostJpy).toBe(0);
    expect(r.currentMonthCallCount).toBe(0);
  });

  it('LLM 系 ApiCallLog のみ集計対象 (input/output どちらか not null)', async () => {
    vi.mocked(prisma.apiCallLog.aggregate).mockResolvedValueOnce({
      _sum: { llmInputTokens: BigInt(0), llmOutputTokens: BigInt(0), costJpy: 0 },
      _count: { id: 0 },
    } as never);

    await getAnthropicUsageSummary();

    const callArg = vi.mocked(prisma.apiCallLog.aggregate).mock.calls[0]![0];
    expect(callArg.where).toMatchObject({
      OR: [
        { llmInputTokens: { not: null } },
        { llmOutputTokens: { not: null } },
      ],
    });
  });
});

describe('getBeginnerUsageSummary (PR E / #15)', () => {
  beforeEach(() => vi.clearAllMocks());

  // beginner-expiry の閾値計算で使う「現在時刻」を固定するため、Date.now を mock
  // するアプローチも可能だが、ここでは createdAt を相対的に置くことで状態を再現。
  function daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  it('Beginner テナント 0 件なら全カウント 0', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([] as never);

    const r = await getBeginnerUsageSummary();

    expect(r.totalTenants).toBe(0);
    expect(r.warning60Count).toBe(0);
    expect(r.warning75Count).toBe(0);
    expect(r.expiredCount).toBe(0);
    expect(r.totalCurrentMonthCalls).toBe(0);
  });

  it('期限切迫テナント (60/75/expired) を分類してカウント', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      // 30 日経過 (警告なし)
      { createdAt: daysAgo(30), beginnerEverUpgraded: false, currentMonthApiCallCount: 10 },
      // 65 日経過 → warning_60
      { createdAt: daysAgo(65), beginnerEverUpgraded: false, currentMonthApiCallCount: 20 },
      // 80 日経過 → warning_75
      { createdAt: daysAgo(80), beginnerEverUpgraded: false, currentMonthApiCallCount: 30 },
      // 95 日経過 → expired
      { createdAt: daysAgo(95), beginnerEverUpgraded: false, currentMonthApiCallCount: 40 },
    ] as never);

    const r = await getBeginnerUsageSummary();

    expect(r.totalTenants).toBe(4);
    expect(r.warning60Count).toBe(1);
    expect(r.warning75Count).toBe(1);
    expect(r.expiredCount).toBe(1);
    expect(r.totalCurrentMonthCalls).toBe(100);
  });

  it('management + default tenant を notIn で除外する (#19)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([] as never);

    await getBeginnerUsageSummary();

    const callArg = vi.mocked(prisma.tenant.findMany).mock.calls[0]![0]!;
    expect(callArg.where).toMatchObject({
      id: {
        notIn: [
          '00000000-0000-0000-0000-ffffffffffff',
          '00000000-0000-0000-0000-000000000001',
        ],
      },
      plan: 'beginner',
    });
  });
});

// ================================================================
// 2026-05-11: getCrossTenantUsageSummary に Storage add-on 合計を追加
// ================================================================

describe('getCrossTenantUsageSummary (2026-05-11: Storage add-on 合算)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('LLM 費用 + Storage add-on 月額の合算 + 内訳を返す', async () => {
    vi.mocked(prisma.tenant.count).mockResolvedValueOnce(3 as never);
    vi.mocked(prisma.tenant.aggregate).mockResolvedValueOnce({
      _sum: { currentMonthApiCallCount: 1200, currentMonthApiCostJpy: 8000 },
    } as never);
    vi.mocked(prisma.tenant.groupBy)
      .mockResolvedValueOnce([
        { plan: 'beginner', _count: { id: 1 } },
        { plan: 'expert', _count: { id: 2 } },
      ] as never)
      // storageAddonPlan groupBy: 1 standard (¥0) + 1 plus (¥500) + 1 pro_storage (¥1500)
      .mockResolvedValueOnce([
        { storageAddonPlan: 'standard', _count: { id: 1 } },
        { storageAddonPlan: 'plus', _count: { id: 1 } },
        { storageAddonPlan: 'pro_storage', _count: { id: 1 } },
      ] as never);
    vi.mocked(prisma.user.count).mockResolvedValueOnce(15 as never);

    const r = await getCrossTenantUsageSummary();

    expect(r.tenantCount).toBe(3);
    expect(r.totalActiveUsers).toBe(15);
    expect(r.totalCurrentMonthApiCalls).toBe(1200);
    expect(r.totalCurrentMonthApiCostJpy).toBe(8000);
    // Storage: 0 + 500 + 1500 = 2000
    expect(r.totalCurrentMonthStorageJpy).toBe(2000);
    // 合算: 8000 + 2000 = 10000
    expect(r.totalCurrentMonthCombinedJpy).toBe(10000);
    expect(r.planDistribution).toEqual([
      { plan: 'beginner', count: 1 },
      { plan: 'expert', count: 2 },
    ]);
  });

  it('顧客テナント 0 件なら全 0 を返す', async () => {
    vi.mocked(prisma.tenant.count).mockResolvedValueOnce(0 as never);
    vi.mocked(prisma.tenant.aggregate).mockResolvedValueOnce({
      _sum: { currentMonthApiCallCount: null, currentMonthApiCostJpy: null },
    } as never);
    vi.mocked(prisma.tenant.groupBy)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);
    vi.mocked(prisma.user.count).mockResolvedValueOnce(0 as never);

    const r = await getCrossTenantUsageSummary();

    expect(r.tenantCount).toBe(0);
    expect(r.totalCurrentMonthApiCostJpy).toBe(0);
    expect(r.totalCurrentMonthStorageJpy).toBe(0);
    expect(r.totalCurrentMonthCombinedJpy).toBe(0);
  });

  it('管理テナント + Default テナントを集計から除外する', async () => {
    vi.mocked(prisma.tenant.count).mockResolvedValueOnce(0 as never);
    vi.mocked(prisma.tenant.aggregate).mockResolvedValueOnce({
      _sum: { currentMonthApiCallCount: null, currentMonthApiCostJpy: null },
    } as never);
    vi.mocked(prisma.tenant.groupBy)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);
    vi.mocked(prisma.user.count).mockResolvedValueOnce(0 as never);

    await getCrossTenantUsageSummary();

    const countWhere = vi.mocked(prisma.tenant.count).mock.calls[0]![0]!.where!;
    expect(countWhere).toMatchObject({
      id: {
        notIn: [
          '00000000-0000-0000-0000-ffffffffffff',
          '00000000-0000-0000-0000-000000000001',
        ],
      },
      deletedAt: null,
    });
    const userWhere = vi.mocked(prisma.user.count).mock.calls[0]![0]!.where!;
    expect(userWhere).toMatchObject({
      isActive: true,
      deletedAt: null,
      tenantId: {
        notIn: [
          '00000000-0000-0000-0000-ffffffffffff',
          '00000000-0000-0000-0000-000000000001',
        ],
      },
    });
  });
});

// ================================================================
// 2026-05-11: getDefaultTenantOwnSummary (Default テナント = 運営者自身の個別取得)
// ================================================================

describe('getDefaultTenantOwnSummary (2026-05-11)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Default テナント存在時: 各種使用量と Storage 上限を計算して返す', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: '00000000-0000-0000-0000-000000000001',
      tenantSeq: null,
      slug: 'default',
      name: 'Default',
      plan: 'expert',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      currentMonthApiCallCount: 42,
      currentMonthApiCostJpy: 420,
      storageAddonPlan: 'standard',
      storageBytesUsed: BigInt(10 * 1024 * 1024), // 10MB
    } as never);
    vi.mocked(prisma.user.count).mockResolvedValueOnce(5 as never);

    const r = await getDefaultTenantOwnSummary();

    expect(r).not.toBeNull();
    expect(r?.id).toBe('00000000-0000-0000-0000-000000000001');
    expect(r?.activeUserCount).toBe(5);
    expect(r?.currentMonthApiCallCount).toBe(42);
    expect(r?.currentMonthApiCostJpy).toBe(420);
    expect(r?.storageBytesUsed).toBe(10 * 1024 * 1024);
    // Expert (150MB) + standard (0) = 150MB
    expect(r?.storageLimitBytes).toBe(150 * 1024 * 1024);
    expect(r?.storageUsageRatio).toBeCloseTo((10 * 1024 * 1024) / (150 * 1024 * 1024), 5);

    // findFirst が DEFAULT_TENANT_ID を引いていること (運営者自身のテナント)
    const whereArg = vi.mocked(prisma.tenant.findFirst).mock.calls[0]![0]!.where!;
    expect(whereArg).toMatchObject({
      id: '00000000-0000-0000-0000-000000000001',
      deletedAt: null,
    });
  });

  it('Default テナント不在時 (= seed 未投入 / 削除済) は null を返す', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null);

    const r = await getDefaultTenantOwnSummary();

    expect(r).toBeNull();
    // user.count は呼ばれない (早期 return)
    expect(prisma.user.count).not.toHaveBeenCalled();
  });

  it('不正な plan / storageAddonPlan は beginner / standard へフォールバック', async () => {
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: '00000000-0000-0000-0000-000000000001',
      tenantSeq: null,
      slug: 'default',
      name: 'Default',
      plan: 'unknown_plan',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      currentMonthApiCallCount: 0,
      currentMonthApiCostJpy: 0,
      storageAddonPlan: 'unknown_addon',
      storageBytesUsed: BigInt(0),
    } as never);
    vi.mocked(prisma.user.count).mockResolvedValueOnce(0 as never);

    const r = await getDefaultTenantOwnSummary();

    // beginner (50MB) + standard (0) = 50MB
    expect(r?.storageLimitBytes).toBe(50 * 1024 * 1024);
    expect(r?.storageAddonPlan).toBe('standard');
  });
});

// ================================================================
// 2026-05-09 (PR F / #18): purgeOldDeletedTenants で users を物理削除しないこと
// ================================================================

describe('purgeOldDeletedTenants (PR F / #18)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 全 deleteMany が { count: 0 } を返すデフォルトを設定
    const zero = { count: 0 } as never;
    vi.mocked(prisma.mention.deleteMany).mockResolvedValue(zero);
    vi.mocked(prisma.comment.deleteMany).mockResolvedValue(zero);
    vi.mocked(prisma.attachment.deleteMany).mockResolvedValue(zero);
    vi.mocked(prisma.knowledgeProject.deleteMany).mockResolvedValue(zero);
    vi.mocked(prisma.taskKnowledge.deleteMany).mockResolvedValue(zero);
    vi.mocked(prisma.taskProgressLog.deleteMany).mockResolvedValue(zero);
    vi.mocked(prisma.task.deleteMany).mockResolvedValue(zero);
    vi.mocked(prisma.estimate.deleteMany).mockResolvedValue(zero);
    vi.mocked(prisma.projectMember.deleteMany).mockResolvedValue(zero);
    vi.mocked(prisma.riskIssue.deleteMany).mockResolvedValue(zero);
    vi.mocked(prisma.retrospective.deleteMany).mockResolvedValue(zero);
    vi.mocked(prisma.memo.deleteMany).mockResolvedValue(zero);
    vi.mocked(prisma.stakeholder.deleteMany).mockResolvedValue(zero);
    vi.mocked(prisma.knowledge.deleteMany).mockResolvedValue(zero);
    vi.mocked(prisma.suggestionExplanation.deleteMany).mockResolvedValue(zero);
    vi.mocked(prisma.project.deleteMany).mockResolvedValue(zero);
    vi.mocked(prisma.customer.deleteMany).mockResolvedValue(zero);
    vi.mocked(prisma.tenantImportPreview.deleteMany).mockResolvedValue(zero);
  });

  it('対象テナント (deletedAt から 90 日以上経過) があっても user.deleteMany は呼ばれない (#18)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      { id: 'old-tenant-1' },
      { id: 'old-tenant-2' },
    ] as never);

    await purgeOldDeletedTenants(new Date('2026-05-09T00:00:00Z'));

    // 業務データの deleteMany は呼ばれるが、user.deleteMany は意図的に呼ばない
    expect(prisma.project.deleteMany).toHaveBeenCalled();
    expect(prisma.knowledge.deleteMany).toHaveBeenCalled();
    expect(prisma.user.deleteMany).not.toHaveBeenCalled();
  });

  it('対象テナント 0 件なら deleteMany は一切呼ばれない', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([] as never);

    const r = await purgeOldDeletedTenants(new Date('2026-05-09T00:00:00Z'));

    expect(r.attempted).toBe(0);
    expect(prisma.user.deleteMany).not.toHaveBeenCalled();
    expect(prisma.project.deleteMany).not.toHaveBeenCalled();
  });

  it('SuggestionExplanation も削除対象に含まれる (hotfix 既存挙動)', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      { id: 'old-tenant-1' },
    ] as never);

    await purgeOldDeletedTenants(new Date('2026-05-09T00:00:00Z'));

    expect(prisma.suggestionExplanation.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 'old-tenant-1' },
    });
  });
});
