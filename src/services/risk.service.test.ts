import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    riskIssue: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      // PR #161 / PR #165 / UI_PATTERNS §35: bulkUpdateRisksVisibilityFromList で使用
      updateMany: vi.fn(),
    },
    // PR feat/asset-multi-project-linking: link/unlink API
    riskIssueProject: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    project: { findFirst: vi.fn() },
    projectMember: { findMany: vi.fn() },
    // 2026-06-02: listRisks も作成者/更新者名を user.findMany で解決するため既定 [] を設定
    user: { findMany: vi.fn().mockResolvedValue([]) },
    // PR #89: deleteRisk が attachment.updateMany を $transaction 内で呼ぶ
    attachment: { updateMany: vi.fn() },
    // PR fix/visibility-auth-matrix: deleteRisk が comment.updateMany を $transaction 内で呼ぶ
    comment: { updateMany: vi.fn() },
    // v1.3.0 資産導線機能: deleteRisk が deleteAssetLinksForEntity 経由で呼ぶ (count 読み取りのため既定値必須)
    assetLink: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

// PR #5-c (T-03 Phase 2): createRisk / updateRisk から呼ばれる embedding helper をモック
vi.mock('./embedding.service', () => ({
  generateAndPersistEntityEmbedding: vi.fn().mockResolvedValue(undefined),
  generateAndPersistBatchEmbeddings: vi.fn().mockResolvedValue({ generated: 0, failed: 0, costJpy: 0 }),
}));

// feat/asset-assignee-expansion (2026-05-26): クロステナント assigneeId 検証を mock
//   (専用テストは src/lib/assignee-validation.test.ts、本ファイルでは pass 扱い)
vi.mock('@/lib/assignee-validation', () => ({
  assertAssigneeTenant: vi.fn().mockResolvedValue(undefined),
}));

import {
  listRisks,
  listAllRisksForViewer,
  getRisk,
  createRisk,
  updateRisk,
  deleteRisk,
  bulkUpdateRisksVisibilityFromList,
  risksToCSV,
  linkRiskToProject,
  unlinkRiskFromProject,
  type RiskDTO,
} from './risk.service';
import { prisma } from '@/lib/db';
import { getMockCallArg } from '@/lib/test-mock-helpers';
import { generateAndPersistEntityEmbedding, generateAndPersistBatchEmbeddings } from './embedding.service';

const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001';

const now = new Date('2026-04-21T10:00:00Z');
const rRow = (o: Record<string, unknown> = {}) => ({
  id: 'r-1',
  projectId: 'p-1',
  type: 'risk',
  title: '件名',
  content: '内容',
  cause: null,
  impact: 'high',
  likelihood: 'medium',
  priority: 'high',
  responsePolicy: null,
  responseDetail: null,
  reporterId: 'u-1',
  reporter: { name: 'Alice' },
  assigneeId: 'u-2',
  assignee: { name: 'Bob' },
  deadline: new Date('2026-05-01'),
  state: 'open',
  result: null,
  lessonLearned: null,
  visibility: 'public',
  riskNature: 'threat',
  createdBy: 'u-1',
  updatedBy: 'u-1',
  createdAt: now,
  updatedAt: now,
  ...o,
});

describe('listRisks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('admin は全リスクをフィルタなしで取得 (M:N 経由)', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([rRow()] as never);

    await listRisks('p-1', 'admin-id', 'admin', TEST_TENANT_ID);

    // PR feat/asset-multi-project-linking: scope は M:N (riskIssueProjects) 経由で判定する。
    expect(prisma.riskIssue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          riskIssueProjects: { some: { projectId: 'p-1' } },
        }),
      }),
    );
    const call = getMockCallArg(vi.mocked(prisma.riskIssue.findMany));
    expect(call.where).not.toHaveProperty('OR');
  });

  it('非 admin は public + 自分の draft (2026-05-01 仕様変更: 自分の draft は表示)', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([]);
    await listRisks('p-1', 'u-1', 'general', TEST_TENANT_ID);
    const call = getMockCallArg(vi.mocked(prisma.riskIssue.findMany));
    // visibility は OR で「public OR (draft AND reporterId=自分)」
    expect(call.where.OR).toEqual([
      { visibility: 'public' },
      { visibility: 'draft', reporterId: 'u-1' },
    ]);
    expect(call.where).not.toHaveProperty('visibility');
  });
});

describe('listAllRisksForViewer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('admin はマスキングなし (projectName / reporterName 公開)', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      { ...rRow(), project: { id: 'p-1', name: 'PJ A', deletedAt: null } },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: 'u-1', name: 'Alice' },
    ] as never);

    const r = await listAllRisksForViewer('admin-1', 'admin', 'tenant-A');

    expect(r[0].projectName).toBe('PJ A');
    expect(r[0].reporterName).toBe('Alice');
    expect(r[0].canAccessProject).toBe(true);
  });

  // fix/cross-list-non-member-columns (2026-04-27): 非メンバーでも担当者・起票者・
  // 作成者・更新者の氏名は公開する仕様に変更 (横断ビュー = visibility='public' 行の
  // ナレッジ共有を促進する目的)。projectName のみ機微情報扱いを維持。
  it('非 admin & 非メンバーは projectName のみマスク、氏名は公開 (2026-04-27 仕様変更)', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([]);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      { ...rRow(), project: { id: 'p-1', name: 'PJ A', deletedAt: null } },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: 'u-1', name: 'Alice' },
      { id: 'u-2', name: 'Bob' },
    ] as never);

    const r = await listAllRisksForViewer('u-99', 'general', 'tenant-A');

    expect(r[0].projectName).toBe(null); // プロジェクト名は引き続き機微扱い
    expect(r[0].reporterName).toBe('Alice'); // 氏名は公開 (rRow().reporter.name)
    expect(r[0].assigneeName).toBe('Bob');   // rRow().assignee.name
    expect(r[0].createdByName).toBe('Alice'); // userMap 経由
    expect(r[0].updatedByName).toBe('Alice');
    expect(r[0].canAccessProject).toBe(false);
    expect(r[0].projectDeleted).toBe(false); // admin 以外には秘匿
  });

  it('admin には削除済みプロジェクトの projectDeleted=true が見える', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      { ...rRow(), project: { id: 'p-1', name: 'Gone', deletedAt: new Date() } },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    const r = await listAllRisksForViewer('admin-1', 'admin', 'tenant-A');

    expect(r[0].projectDeleted).toBe(true);
    expect(r[0].canAccessProject).toBe(false); // deleted なのでリンク不可
  });

  it('2026-04-25: visibility フィルタは admin/非 admin 共に public 固定 (全○○ には draft を含めない)', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([]);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    // 非 admin
    await listAllRisksForViewer('u-1', 'general', 'tenant-A');
    const generalCall = getMockCallArg(vi.mocked(prisma.riskIssue.findMany));
    expect(generalCall.where.visibility).toBe('public');
    expect(generalCall.where).not.toHaveProperty('OR');

    vi.clearAllMocks();
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    // admin (旧仕様: visibility 制約なし → 要件変更で admin も public 固定。
    // admin が draft を管理削除したい場合はプロジェクト個別画面から行う)
    await listAllRisksForViewer('admin-1', 'admin', 'tenant-A');
    const adminCall = getMockCallArg(vi.mocked(prisma.riskIssue.findMany));
    expect(adminCall.where.visibility).toBe('public');
  });

  // feat/crud-permission-redesign (2026-05-20): severity-1 情報漏洩修正の回帰防止。
  //   toRiskDTO は無条件で linkedProjects[].name を返すが、listAllRisksForViewer が
  //   per-link で gate して非 ProjectMember には null を返すこと。
  it('linkedProjects: per-link gate (非メンバーは全 name=null)', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([]);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      {
        ...rRow(),
        project: { id: 'p-1', name: 'PJ-1', deletedAt: null },
        riskIssueProjects: [
          { projectId: 'p-1', project: { id: 'p-1', name: 'PJ-1', deletedAt: null } },
          { projectId: 'p-2', project: { id: 'p-2', name: 'PJ-2', deletedAt: null } },
        ],
      },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    const r = await listAllRisksForViewer('u-99', 'general', 'tenant-A');

    expect(r[0].linkedProjects).toHaveLength(2);
    expect(r[0].linkedProjects[0]).toMatchObject({ id: 'p-1', name: null });
    expect(r[0].linkedProjects[1]).toMatchObject({ id: 'p-2', name: null });
  });

  it('linkedProjects: per-link gate (一部のみメンバー → メンバー側のみ name 表示)', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([
      { projectId: 'p-1' },
    ] as never);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      {
        ...rRow(),
        project: { id: 'p-1', name: 'PJ-1', deletedAt: null },
        riskIssueProjects: [
          { projectId: 'p-1', project: { id: 'p-1', name: 'PJ-1', deletedAt: null } },
          { projectId: 'p-2', project: { id: 'p-2', name: 'PJ-2', deletedAt: null } },
        ],
      },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    const r = await listAllRisksForViewer('u-1', 'general', 'tenant-A');

    expect(r[0].linkedProjects[0]).toMatchObject({ id: 'p-1', name: 'PJ-1' });
    expect(r[0].linkedProjects[1]).toMatchObject({ id: 'p-2', name: null });
  });

  it('linkedProjects: admin は全 name 表示 (per-link gate 対象外)', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      {
        ...rRow(),
        project: { id: 'p-1', name: 'PJ-1', deletedAt: null },
        riskIssueProjects: [
          { projectId: 'p-1', project: { id: 'p-1', name: 'PJ-1', deletedAt: null } },
          { projectId: 'p-2', project: { id: 'p-2', name: 'PJ-2', deletedAt: null } },
        ],
      },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    const r = await listAllRisksForViewer('admin-1', 'admin', 'tenant-A');

    expect(r[0].linkedProjects[0]).toMatchObject({ id: 'p-1', name: 'PJ-1' });
    expect(r[0].linkedProjects[1]).toMatchObject({ id: 'p-2', name: 'PJ-2' });
  });
});

describe('getRisk', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在しなければ null', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(null);
    expect(await getRisk('x')).toBe(null);
  });

  it('認可引数なしなら visibility 問わず生 DTO を返す (内部呼び出し用)', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(
      rRow({ visibility: 'draft', reporterId: 'someone-else' }) as never,
    );
    const r = await getRisk('r-1');
    expect(r?.id).toBe('r-1');
  });

  it('public なら誰でも参照可', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(
      rRow({ visibility: 'public' }) as never,
    );
    const r = await getRisk('r-1', 'u-other', 'general');
    expect(r?.id).toBe('r-1');
  });

  it('draft は作成者本人なら参照可', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(
      rRow({ visibility: 'draft', reporterId: 'u-1' }) as never,
    );
    const r = await getRisk('r-1', 'u-1', 'general');
    expect(r?.id).toBe('r-1');
  });

  it('draft は admin なら参照可', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(
      rRow({ visibility: 'draft', reporterId: 'u-1' }) as never,
    );
    const r = await getRisk('r-1', 'admin-x', 'admin');
    expect(r?.id).toBe('r-1');
  });

  it('draft は他人 (作成者でも admin でもない) なら null を返す', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(
      rRow({ visibility: 'draft', reporterId: 'u-1' }) as never,
    );
    const r = await getRisk('r-1', 'u-other', 'general');
    expect(r).toBe(null);
  });
});

describe('createRisk', () => {
  beforeEach(() => vi.clearAllMocks());

  // ★severity-1 regression (fix/tenant-id-default-removal, 2026-05-28, ADR-0024):
  //   旧バグでは createRisk が tenantId を data に渡しておらず、schema の DB DEFAULT
  //   ('00000000-...-001') で silent に Default テナントへ混入していた。
  //   本テストは「指定された tenantId が data に明示的に含まれる」ことを保証する。
  //   本テストが落ちた場合 = テナント越境セキュリティバグの再発を意味する。
  it('★severity-1 regression: tenantId が data に明示的に渡される (Default テナント silent 混入の防止)', async () => {
    vi.mocked(prisma.riskIssue.create).mockResolvedValue(rRow() as never);
    const OTHER_TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await createRisk(
      'p-1',
      {
        type: 'issue',
        title: 't',
        content: 'c',
        impact: 'high',
        likelihood: 'medium',
        assigneeId: null,
        deadline: null,
        visibility: 'draft',
      } as never,
      'u-1',
      OTHER_TENANT_ID,
    );
    expect(prisma.riskIssue.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: OTHER_TENANT_ID }),
      }),
    );
  });

  it('risk 型は riskNature を保存する', async () => {
    vi.mocked(prisma.riskIssue.create).mockResolvedValue(rRow() as never);
    await createRisk(
      'p-1',
      {
        type: 'risk',
        title: 't',
        content: 'c',
        cause: null,
        impact: 'high',
        likelihood: 'medium',
        priority: 'high',
        responsePolicy: null,
        responseDetail: null,
        assigneeId: null,
        deadline: null,
        visibility: 'public',
        riskNature: 'threat',
      } as never,
      'u-1',
      TEST_TENANT_ID,
    );

    expect(prisma.riskIssue.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ riskNature: 'threat' }),
      }),
    );
  });

  it('issue 型は riskNature を null にする', async () => {
    vi.mocked(prisma.riskIssue.create).mockResolvedValue(rRow() as never);
    await createRisk(
      'p-1',
      {
        type: 'issue',
        title: 't',
        content: 'c',
        cause: null,
        impact: 'high',
        likelihood: null,
        priority: 'high',
        responsePolicy: null,
        responseDetail: null,
        assigneeId: null,
        deadline: null,
        visibility: 'public',
        riskNature: null,
      } as never,
      'u-1',
      TEST_TENANT_ID,
    );
    const call = getMockCallArg(vi.mocked(prisma.riskIssue.create));
    expect(call.data.riskNature).toBe(null);
  });

  it('PR-γ: priority は impact × likelihood から自動算出される (risk: 影響度高+発生確率低 → low)', async () => {
    vi.mocked(prisma.riskIssue.create).mockResolvedValue(rRow() as never);
    await createRisk(
      'p-1',
      {
        type: 'risk',
        title: 't',
        content: 'c',
        impact: 'high',
        likelihood: 'low',
        assigneeId: null,
        deadline: null,
        visibility: 'draft',
      } as never,
      'u-1',
      TEST_TENANT_ID,
    );
    const call = getMockCallArg(vi.mocked(prisma.riskIssue.create));
    expect(call.data.priority).toBe('low');
  });

  it('PR-γ: risk 高/高 → high', async () => {
    vi.mocked(prisma.riskIssue.create).mockResolvedValue(rRow() as never);
    await createRisk('p-1', {
      type: 'risk', title: 't', content: 'c', impact: 'high', likelihood: 'high',
      assigneeId: null, deadline: null, visibility: 'draft',
    } as never, 'u-1', TEST_TENANT_ID);
    expect(getMockCallArg(vi.mocked(prisma.riskIssue.create)).data.priority).toBe('high');
  });

  it('PR-γ: risk 低/低 → minimal', async () => {
    vi.mocked(prisma.riskIssue.create).mockResolvedValue(rRow() as never);
    await createRisk('p-1', {
      type: 'risk', title: 't', content: 'c', impact: 'low', likelihood: 'low',
      assigneeId: null, deadline: null, visibility: 'draft',
    } as never, 'u-1', TEST_TENANT_ID);
    expect(getMockCallArg(vi.mocked(prisma.riskIssue.create)).data.priority).toBe('minimal');
  });

  it('PR-γ: issue 重要度高/緊急度低 → medium (重要度重視)', async () => {
    vi.mocked(prisma.riskIssue.create).mockResolvedValue(rRow() as never);
    await createRisk('p-1', {
      type: 'issue', title: 't', content: 'c', impact: 'high', likelihood: 'low',
      assigneeId: null, deadline: null, visibility: 'draft',
    } as never, 'u-1', TEST_TENANT_ID);
    expect(getMockCallArg(vi.mocked(prisma.riskIssue.create)).data.priority).toBe('medium');
  });

  it('PR-γ: issue 重要度低/緊急度高 → low (重要度重視: risk と逆転)', async () => {
    vi.mocked(prisma.riskIssue.create).mockResolvedValue(rRow() as never);
    await createRisk('p-1', {
      type: 'issue', title: 't', content: 'c', impact: 'low', likelihood: 'high',
      assigneeId: null, deadline: null, visibility: 'draft',
    } as never, 'u-1', TEST_TENANT_ID);
    expect(getMockCallArg(vi.mocked(prisma.riskIssue.create)).data.priority).toBe('low');
  });

  // PR #5-c (T-03 Phase 2): 本体 INSERT 後に embedding helper が呼ばれる (fail-safe)
  // (2026-05-15) state='resolved' 限定に変更。state='open' (default) では生成されない。
  it('createRisk: visibility=public && state=resolved で初期作成時に embedding が呼ばれる (import 経由)', async () => {
    vi.mocked(prisma.riskIssue.create).mockResolvedValue(
      rRow({ id: 'r-new', visibility: 'public', state: 'resolved' }) as never,
    );
    await createRisk(
      'p-1',
      {
        type: 'risk', title: 'タイトル', content: '内容', impact: 'high', likelihood: 'low',
        assigneeId: null, deadline: null, visibility: 'public', riskNature: 'threat',
      } as never,
      'u-1',
      TEST_TENANT_ID,
    );

    expect(generateAndPersistEntityEmbedding).toHaveBeenCalledTimes(1);
    const args = getMockCallArg(vi.mocked(generateAndPersistEntityEmbedding));
    expect(args.table).toBe('risks_issues');
    expect(args.rowId).toBe('r-new');
    expect(args.tenantId).toBe(TEST_TENANT_ID);
    expect(args.userId).toBe('u-1');
    expect(args.featureUnit).toBe('risk-issue-embedding');
    expect(args.text).toContain('タイトル');
    expect(args.text).toContain('内容');
  });

  // (2026-05-15) 通常の create は state='open' (default) で起票されるため embedding 不要
  it('createRisk: 通常起票 (state=open 既定) では embedding を生成しない (resolved 化まで保留)', async () => {
    vi.mocked(prisma.riskIssue.create).mockResolvedValue(
      rRow({ id: 'r-open', visibility: 'public', state: 'open' }) as never,
    );
    await createRisk(
      'p-1',
      {
        type: 'risk', title: 'タイトル', content: '内容', impact: 'high', likelihood: 'low',
        assigneeId: null, deadline: null, visibility: 'public', riskNature: 'threat',
      } as never,
      'u-1',
      TEST_TENANT_ID,
    );
    expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
  });

  // PR #357 (2026-05-14): visibility=draft なら embedding 生成しない
  it('createRisk: visibility=draft なら embedding を生成しない (Voyage API 課金を発生させない)', async () => {
    vi.mocked(prisma.riskIssue.create).mockResolvedValue(rRow({ id: 'r-draft', visibility: 'draft' }) as never);
    await createRisk(
      'p-1',
      {
        type: 'risk', title: 'タイトル', content: '内容', impact: 'high', likelihood: 'low',
        assigneeId: null, deadline: null, visibility: 'draft', riskNature: 'threat',
      } as never,
      'u-1',
      TEST_TENANT_ID,
    );
    expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
  });
});

describe('updateRisk', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在しなければ NOT_FOUND', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(null);
    await expect(updateRisk('x', { title: 'new' }, 'u-1', TEST_TENANT_ID)).rejects.toThrow(
      'NOT_FOUND',
    );
  });

  it('作成者でも担当者でもない (admin でも) は FORBIDDEN', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(
      { reporterId: 'u-1', assigneeId: null } as never,
    );
    await expect(updateRisk('r-1', { title: 'new' }, 'u-other', TEST_TENANT_ID)).rejects.toThrow(
      'FORBIDDEN',
    );
    // admin であっても他人のリスクは編集不可
    await expect(updateRisk('r-1', { title: 'new' }, 'admin-x', TEST_TENANT_ID)).rejects.toThrow(
      'FORBIDDEN',
    );
  });

  // feat/asset-assignee-expansion (2026-05-26): 担当者も update 可能 (引継ぎ後の運用者向け)
  it('担当者 (assigneeId === userId) は update 可能', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(
      { reporterId: 'u-creator', assigneeId: 'u-assignee' } as never,
    );
    vi.mocked(prisma.riskIssue.update).mockResolvedValue(rRow() as never);

    await updateRisk('r-1', { title: 'new', state: 'resolved' }, 'u-assignee', TEST_TENANT_ID);

    const call = getMockCallArg(vi.mocked(prisma.riskIssue.update));
    expect(call.data.title).toBe('new');
    expect(call.data.updatedBy).toBe('u-assignee');
  });

  // 既存テスト「作成者でも担当者でもない FORBIDDEN」とは別に、assigneeId=null パターンも明示
  it('assigneeId=null かつ呼出ユーザが作成者でも担当者でもない → FORBIDDEN', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(
      { reporterId: 'u-1', assigneeId: null } as never,
    );
    await expect(updateRisk('r-1', { title: 'new' }, 'u-third', TEST_TENANT_ID)).rejects.toThrow(
      'FORBIDDEN',
    );
  });

  it('作成者本人なら指定フィールドのみ data に積む', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ reporterId: 'u-1' } as never);
    vi.mocked(prisma.riskIssue.update).mockResolvedValue(rRow() as never);

    await updateRisk('r-1', { title: 'new', state: 'resolved' }, 'u-1', TEST_TENANT_ID);

    const call = getMockCallArg(vi.mocked(prisma.riskIssue.update));
    expect(call.data.title).toBe('new');
    expect(call.data.state).toBe('resolved');
    expect(call.data.updatedBy).toBe('u-1');
    expect(call.data.content).toBeUndefined();
  });

  it('deadline 文字列を Date に変換する', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ reporterId: 'u-1' } as never);
    vi.mocked(prisma.riskIssue.update).mockResolvedValue(rRow() as never);

    await updateRisk('r-1', { deadline: '2026-06-01' }, 'u-1', TEST_TENANT_ID);

    const call = getMockCallArg(vi.mocked(prisma.riskIssue.update));
    expect(call.data.deadline).toBeInstanceOf(Date);
  });

  // PR #5-c: text フィールド変更時のみ embedding 再生成 (LLM 課金回避)
  // (2026-05-15) state='resolved' でないと embedding 生成しない
  it('updateRisk: text フィールド変更時 (resolved の場合) は embedding を再生成する', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      reporterId: 'u-1', title: '旧', content: '旧内容',
      cause: null, responsePolicy: null, responseDetail: null,
      visibility: 'public', state: 'resolved',
    } as never);
    vi.mocked(prisma.riskIssue.update).mockResolvedValue(rRow({ state: 'resolved' }) as never);

    await updateRisk('r-1', { title: 'new title' }, 'u-1', TEST_TENANT_ID);

    expect(generateAndPersistEntityEmbedding).toHaveBeenCalledTimes(1);
    const args = getMockCallArg(vi.mocked(generateAndPersistEntityEmbedding));
    expect(args.table).toBe('risks_issues');
    expect(args.rowId).toBe('r-1');
    expect(args.tenantId).toBe(TEST_TENANT_ID);
  });

  // (2026-05-15) state='resolved' のまま text 非変更 → 再生成しない (LLM 課金回避)
  it('updateRisk: resolved のまま text 非変更 (assignee のみ) は embedding 再生成しない', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      reporterId: 'u-1', title: 't', content: 'c',
      cause: null, responsePolicy: null, responseDetail: null,
      visibility: 'public', state: 'resolved',
    } as never);
    vi.mocked(prisma.riskIssue.update).mockResolvedValue(rRow({ state: 'resolved' }) as never);

    await updateRisk('r-1', { assigneeId: 'u-2' }, 'u-1', TEST_TENANT_ID);

    expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
  });

  // (2026-05-15) state='open' → 'resolved' 遷移: text 非変更でも initial embedding 生成
  it('updateRisk: state が open → resolved に遷移 (text 非変更) → embedding 初回生成', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      reporterId: 'u-1', title: 't', content: 'c',
      cause: null, responsePolicy: null, responseDetail: null,
      visibility: 'public', state: 'open',
    } as never);
    vi.mocked(prisma.riskIssue.update).mockResolvedValue(rRow({ state: 'resolved' }) as never);

    await updateRisk('r-1', { state: 'resolved' }, 'u-1', TEST_TENANT_ID);

    expect(generateAndPersistEntityEmbedding).toHaveBeenCalledTimes(1);
  });

  // (2026-05-15) state='resolved' → 'open' (再オープン): 既存 embedding 保持、再生成なし
  it('updateRisk: resolved → open (再オープン) は embedding 再生成しない (既存保持)', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      reporterId: 'u-1', title: 't', content: 'c',
      cause: null, responsePolicy: null, responseDetail: null,
      visibility: 'public', state: 'resolved',
    } as never);
    vi.mocked(prisma.riskIssue.update).mockResolvedValue(rRow({ state: 'open' }) as never);

    await updateRisk('r-1', { state: 'open', title: 'changed' }, 'u-1', TEST_TENANT_ID);

    expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
  });

  // (2026-05-15) state='open' のまま text 変更 → 再生成しない (提案候補外なので Voyage 課金回避)
  it('updateRisk: state=open のまま text 変更しても embedding 生成しない (提案候補外)', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      reporterId: 'u-1', title: 't', content: 'c',
      cause: null, responsePolicy: null, responseDetail: null,
      visibility: 'public', state: 'open',
    } as never);
    vi.mocked(prisma.riskIssue.update).mockResolvedValue(rRow({ state: 'open' }) as never);

    await updateRisk('r-1', { title: 'new title' }, 'u-1', TEST_TENANT_ID);

    expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
  });

  // ================================================================
  // PR #357 (2026-05-14) + (2026-05-15): visibility × state × embedding 生成マトリクス
  // 「visibility='public' AND state='resolved' AND (state 遷移 or text 変更)」のみ embedding
  // ================================================================
  describe('visibility × state × embedding 生成判定', () => {
    // v1.3.0: public 化は occurrence / cause / responsePolicy / content 非空が条件のため、
    //   public 遷移テストが PUBLIC_REQUIRES_FIELDS で弾かれないよう既存値を埋める。
    const baseExisting = {
      reporterId: 'u-1',
      title: '既存',
      content: '既存内容',
      occurrence: '既存事象',
      cause: '既存原因',
      responsePolicy: '既存対応策',
      responseDetail: null,
    };

    it('draft → draft (text 変更あり) → 呼ばれない (draft は提案候補外なので課金しない)', async () => {
      vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
        ...baseExisting, visibility: 'draft', state: 'resolved',
      } as never);
      vi.mocked(prisma.riskIssue.update).mockResolvedValue(rRow({ visibility: 'draft' }) as never);
      await updateRisk('r-1', { title: '新', visibility: 'draft' }, 'u-1', TEST_TENANT_ID);
      expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
    });

    // (2026-05-15) draft → public 遷移時、state='resolved' でなければ embedding 生成しない
    it('draft → public + state=open → 呼ばれない (resolved でないので提案候補外)', async () => {
      vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
        ...baseExisting, visibility: 'draft', state: 'open',
      } as never);
      vi.mocked(prisma.riskIssue.update).mockResolvedValue(rRow({ visibility: 'public' }) as never);
      await updateRisk('r-1', { visibility: 'public' }, 'u-1', TEST_TENANT_ID);
      expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
    });

    // (2026-05-15) draft → public 遷移かつ state='resolved' なら initial embedding 生成
    it('draft → public + state=resolved (text 変更なし) → 呼ばれる (公開化時の初回生成)', async () => {
      vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
        ...baseExisting, visibility: 'draft', state: 'resolved',
      } as never);
      vi.mocked(prisma.riskIssue.update).mockResolvedValue(rRow({ visibility: 'public' }) as never);
      await updateRisk('r-1', { visibility: 'public' }, 'u-1', TEST_TENANT_ID);
      expect(generateAndPersistEntityEmbedding).toHaveBeenCalledTimes(1);
    });

    it('public → draft (text 変更あり) → 呼ばれない (既存 embedding は保持)', async () => {
      vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
        ...baseExisting, visibility: 'public', state: 'resolved',
      } as never);
      vi.mocked(prisma.riskIssue.update).mockResolvedValue(rRow({ visibility: 'draft' }) as never);
      await updateRisk('r-1', { title: '新', visibility: 'draft' }, 'u-1', TEST_TENANT_ID);
      expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
    });
  });
});

describe('deleteRisk', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在しなければ NOT_FOUND', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(null);
    await expect(
      deleteRisk('x', 'u-1', 'general', TEST_TENANT_ID, 'project'),
    ).rejects.toThrow('NOT_FOUND');
  });

  // feat/crud-permission-redesign (2026-05-20): context 別に削除権限が変わる
  it('(context=project): 作成者本人は削除できる', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ reporterId: 'u-1' } as never);
    vi.mocked(prisma.riskIssue.update).mockResolvedValue({} as never);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 0 } as never);

    await deleteRisk('r-1', 'u-1', 'general', TEST_TENANT_ID, 'project');

    expect(prisma.riskIssue.update).toHaveBeenCalledWith({
      where: { id: 'r-1' },
      data: { deletedAt: expect.any(Date), updatedBy: 'u-1' },
    });
  });

  it('(context=project): admin も他人作成は FORBIDDEN', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ reporterId: 'u-1' } as never);
    await expect(
      deleteRisk('r-1', 'admin-x', 'admin', TEST_TENANT_ID, 'project'),
    ).rejects.toThrow('FORBIDDEN');
    expect(prisma.riskIssue.update).not.toHaveBeenCalled();
  });

  it('(context=global): admin は他人作成も削除可 (全リスク画面からの管理削除)', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ reporterId: 'u-1' } as never);
    vi.mocked(prisma.riskIssue.update).mockResolvedValue({} as never);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 0 } as never);

    await deleteRisk('r-1', 'admin-x', 'admin', TEST_TENANT_ID, 'global');

    expect(prisma.riskIssue.update).toHaveBeenCalled();
  });

  it('(context=global): 非 admin (作成者本人) も FORBIDDEN', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ reporterId: 'u-1' } as never);
    await expect(
      deleteRisk('r-1', 'u-1', 'general', TEST_TENANT_ID, 'global'),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('(context=project): 非 admin の第三者は FORBIDDEN', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(
      { reporterId: 'u-1', assigneeId: null } as never,
    );
    await expect(
      deleteRisk('r-1', 'u-other', 'general', TEST_TENANT_ID, 'project'),
    ).rejects.toThrow('FORBIDDEN');
  });

  // feat/asset-assignee-expansion (2026-05-26): 担当者も削除可能 (project context)
  it('(context=project): 担当者 (assigneeId === userId) は削除できる', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(
      { reporterId: 'u-creator', assigneeId: 'u-assignee', type: 'risk' } as never,
    );
    vi.mocked(prisma.riskIssue.update).mockResolvedValue({} as never);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 0 } as never);

    await deleteRisk('r-1', 'u-assignee', 'general', TEST_TENANT_ID, 'project');

    expect(prisma.riskIssue.update).toHaveBeenCalledWith({
      where: { id: 'r-1' },
      data: { deletedAt: expect.any(Date), updatedBy: 'u-assignee' },
    });
  });
});

describe('risksToCSV', () => {
  const base = (o: Partial<RiskDTO> = {}): RiskDTO => ({
    id: 'r',
    projectId: 'p',
    linkedProjectIds: ['p'],
    linkedProjects: [{ id: 'p', name: 'Project P', deleted: false }],
    type: 'risk',
    title: 'タイトル',
    content: '',
    // feat/risk-issue-4-section (2026-05-26)
    occurrence: null,
    cause: null,
    impact: 'high',
    likelihood: 'low',
    priority: 'high',
    responsePolicy: null,
    responseDetail: null,
    reporterId: 'u',
    reporterName: 'A',
    assigneeId: null,
    assigneeName: null,
    deadline: '2026-05-01',
    state: 'open',
    result: null,
    lessonLearned: null,
    visibility: 'public',
    riskNature: 'threat',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...o,
  });

  it('BOM 付き CSV を返す', () => {
    const csv = risksToCSV([base()]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('type=risk はリスク、type=issue は課題と表記', () => {
    const csv = risksToCSV([base({ type: 'risk' }), base({ type: 'issue' })]);
    expect(csv).toContain('リスク');
    expect(csv).toContain('課題');
  });

  it('タイトルのダブルクオートはエスケープされる (RFC 4180)', () => {
    const csv = risksToCSV([base({ title: 'a"b' })]);
    // "a""b" になる
    expect(csv).toContain('"a""b"');
  });

  it('ラベル変換: impact=high → 高, state=resolved → 解消', () => {
    const csv = risksToCSV([base({ impact: 'high', state: 'resolved' })]);
    expect(csv).toContain('高');
    expect(csv).toContain('解消');
  });
});

// UI_PATTERNS §35 (2026-05-24): 5 一覧画面の一括編集を visibility-only に統一。
// 旧 bulkUpdateRisksFromList の state+assigneeId+deadline 複合 patch は撤廃。
// 認可方針 (reporter 本人のみ + tenantId scope + projectId scope) は Knowledge / Retrospective
// と同じ二重防御を維持。
describe('bulkUpdateRisksVisibilityFromList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ids が空配列なら updateMany を呼ばずに 0 件で返す', async () => {
    const r = await bulkUpdateRisksVisibilityFromList('p-1', [], 'public', 'u-1', TEST_TENANT_ID);
    expect(r).toEqual({ updatedIds: [], skippedNotOwned: 0, skippedNotFound: 0, embeddingsGenerated: 0 });
    expect(prisma.riskIssue.updateMany).not.toHaveBeenCalled();
  });

  it('reporter 本人のレコードのみ visibility 更新される (他人の混入は skip)', async () => {
    // v1.3.0: public 化は occurrence/cause/responsePolicy/content 非空が条件のため mock で埋める。
    const pub = { title: 't', occurrence: 'o', cause: 'c', responsePolicy: 'rp', content: 'ct' };
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      { id: 'r-1', reporterId: 'u-1', assigneeId: null, ...pub },
      { id: 'r-2', reporterId: 'u-1', assigneeId: null, ...pub },
      { id: 'r-3', reporterId: 'u-OTHER', assigneeId: null, ...pub }, // 他人
    ] as never);
    vi.mocked(prisma.riskIssue.updateMany).mockResolvedValue({ count: 2 } as never);

    const r = await bulkUpdateRisksVisibilityFromList(
      'p-1',
      ['r-1', 'r-2', 'r-3'],
      'public',
      'u-1',
      't-1',
    );

    expect(r.updatedIds).toEqual(['r-1', 'r-2']);
    expect(r.skippedNotOwned).toBe(1);
    expect(r.skippedNotFound).toBe(0);

    const findCall = getMockCallArg(vi.mocked(prisma.riskIssue.findMany));
    expect(findCall.where).toMatchObject({
      id: { in: ['r-1', 'r-2', 'r-3'] },
      deletedAt: null,
      tenantId: 't-1',
      riskIssueProjects: { some: { projectId: 'p-1' } },
    });

    const updateCall = getMockCallArg(vi.mocked(prisma.riskIssue.updateMany));
    // feat/asset-assignee-expansion (2026-05-26): where は OR で「作成者 OR 担当者」
    expect(updateCall.where).toMatchObject({
      id: { in: ['r-1', 'r-2'] },
      tenantId: 't-1',
      OR: [
        { reporterId: 'u-1' },
        { assigneeId: 'u-1' },
      ],
    });
    expect(updateCall.data).toEqual({ visibility: 'public', updatedBy: 'u-1' });
  });

  // feat/asset-assignee-expansion (2026-05-26): 担当者も bulk visibility 更新可能
  it('担当者本人のレコードも visibility 更新対象に含まれる', async () => {
    // v1.3.0: public 化は occurrence/cause/responsePolicy/content 非空が条件のため mock で埋める。
    const pub = { title: 't', occurrence: 'o', cause: 'c', responsePolicy: 'rp', content: 'ct' };
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      { id: 'r-1', reporterId: 'u-creator', assigneeId: 'u-1', ...pub }, // u-1 が担当者
      { id: 'r-2', reporterId: 'u-1', assigneeId: null, ...pub },        // u-1 が作成者
      { id: 'r-3', reporterId: 'u-OTHER', assigneeId: 'u-OTHER', ...pub }, // 第3者
    ] as never);
    vi.mocked(prisma.riskIssue.updateMany).mockResolvedValue({ count: 2 } as never);

    const r = await bulkUpdateRisksVisibilityFromList(
      'p-1',
      ['r-1', 'r-2', 'r-3'],
      'public',
      'u-1',
      't-1',
    );

    expect(r.updatedIds).toEqual(['r-1', 'r-2']);
    expect(r.skippedNotOwned).toBe(1);
  });

  it('visibility=draft (公開撤回) も同じ経路で動く', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      { id: 'r-1', reporterId: 'u-1' },
    ] as never);
    vi.mocked(prisma.riskIssue.updateMany).mockResolvedValue({ count: 1 } as never);

    await bulkUpdateRisksVisibilityFromList('p-1', ['r-1'], 'draft', 'u-1', TEST_TENANT_ID);
    const data = getMockCallArg(vi.mocked(prisma.riskIssue.updateMany)).data;
    expect(data).toEqual({ visibility: 'draft', updatedBy: 'u-1' });
  });

  it('存在しない / 削除済 / 別プロジェクトの id は skippedNotFound にカウント', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      // v1.3.0: public 化は occurrence/cause/responsePolicy/content 非空が条件
      { id: 'r-1', reporterId: 'u-1', title: 't', occurrence: 'o', cause: 'c', responsePolicy: 'rp', content: 'ct' },
    ] as never);
    vi.mocked(prisma.riskIssue.updateMany).mockResolvedValue({ count: 1 } as never);

    const r = await bulkUpdateRisksVisibilityFromList('p-1', ['r-1', 'r-MISSING'], 'public', 'u-1', TEST_TENANT_ID);
    expect(r.updatedIds).toEqual(['r-1']);
    expect(r.skippedNotFound).toBe(1);
  });

  it('全件が他人作成なら updateMany を呼ばない', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      { id: 'r-1', reporterId: 'u-OTHER' },
    ] as never);
    const r = await bulkUpdateRisksVisibilityFromList('p-1', ['r-1'], 'public', 'u-1', TEST_TENANT_ID);
    expect(r.updatedIds).toEqual([]);
    expect(r.skippedNotOwned).toBe(1);
    expect(prisma.riskIssue.updateMany).not.toHaveBeenCalled();
  });

  // UI_PATTERNS §35 (2026-05-24): bulk visibility 経路の embedding コスト最適化テスト。
  // 単発 updateRisk の判定マトリクスと整合: draft→public + state='resolved' のみ embedding 対象。
  describe('embedding 生成 (コスト最適化)', () => {
    it('visibility=draft への変更は embedding を生成しない (Voyage 課金回避)', async () => {
      vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
        { id: 'r-1', reporterId: 'u-1', visibility: 'public', state: 'resolved', title: 't', content: 'c', occurrence: 'o', cause: 'cz', responsePolicy: 'rp', responseDetail: null },
      ] as never);
      vi.mocked(prisma.riskIssue.updateMany).mockResolvedValue({ count: 1 } as never);

      const r = await bulkUpdateRisksVisibilityFromList('p-1', ['r-1'], 'draft', 'u-1', TEST_TENANT_ID);
      expect(r.embeddingsGenerated).toBe(0);
      expect(generateAndPersistBatchEmbeddings).not.toHaveBeenCalled();
    });

    it('public→public のままなら embedding を生成しない (text 変更なしのため)', async () => {
      vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
        { id: 'r-1', reporterId: 'u-1', visibility: 'public', state: 'resolved', title: 't', content: 'c', occurrence: 'o', cause: 'cz', responsePolicy: 'rp', responseDetail: null },
      ] as never);
      vi.mocked(prisma.riskIssue.updateMany).mockResolvedValue({ count: 1 } as never);

      const r = await bulkUpdateRisksVisibilityFromList('p-1', ['r-1'], 'public', 'u-1', TEST_TENANT_ID);
      expect(r.embeddingsGenerated).toBe(0);
      expect(generateAndPersistBatchEmbeddings).not.toHaveBeenCalled();
    });

    it('draft→public でも state≠resolved なら embedding を生成しない (提案エンジン対象外)', async () => {
      vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
        { id: 'r-1', reporterId: 'u-1', visibility: 'draft', state: 'open', title: 't', content: 'c', occurrence: 'o', cause: 'cz', responsePolicy: 'rp', responseDetail: null },
      ] as never);
      vi.mocked(prisma.riskIssue.updateMany).mockResolvedValue({ count: 1 } as never);

      const r = await bulkUpdateRisksVisibilityFromList('p-1', ['r-1'], 'public', 'u-1', TEST_TENANT_ID);
      expect(r.embeddingsGenerated).toBe(0);
      expect(generateAndPersistBatchEmbeddings).not.toHaveBeenCalled();
    });

    it('draft→public 遷移 + state=resolved の行のみ batch で 1 ApiCallLog 集約', async () => {
      vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
        { id: 'r-1', reporterId: 'u-1', visibility: 'draft', state: 'resolved', title: 't1', content: 'c1', occurrence: 'o', cause: 'cz', responsePolicy: 'rp', responseDetail: null },
        { id: 'r-2', reporterId: 'u-1', visibility: 'draft', state: 'resolved', title: 't2', content: 'c2', occurrence: 'o', cause: 'cz', responsePolicy: 'rp', responseDetail: null },
        // 既に public な行は除外される (text 変更なしのため)
        { id: 'r-3', reporterId: 'u-1', visibility: 'public', state: 'resolved', title: 't3', content: 'c3', occurrence: 'o', cause: 'cz', responsePolicy: 'rp', responseDetail: null },
        // state≠resolved も除外される (提案エンジン対象外)
        { id: 'r-4', reporterId: 'u-1', visibility: 'draft', state: 'in_progress', title: 't4', content: 'c4', occurrence: 'o', cause: 'cz', responsePolicy: 'rp', responseDetail: null },
      ] as never);
      vi.mocked(prisma.riskIssue.updateMany).mockResolvedValue({ count: 4 } as never);
      vi.mocked(generateAndPersistBatchEmbeddings).mockResolvedValue({ generated: 2, failed: 0, costJpy: 1 });

      const r = await bulkUpdateRisksVisibilityFromList('p-1', ['r-1', 'r-2', 'r-3', 'r-4'], 'public', 'u-1', TEST_TENANT_ID);

      expect(r.embeddingsGenerated).toBe(2);
      expect(generateAndPersistBatchEmbeddings).toHaveBeenCalledTimes(1); // 1 ApiCallLog 集約
      const args = getMockCallArg(vi.mocked(generateAndPersistBatchEmbeddings));
      expect(args.items).toHaveLength(2);
      expect((args.items as unknown as Array<{ rowId: string }>).map((i) => i.rowId)).toEqual(['r-1', 'r-2']);
      expect(args.featureUnit).toBe('risk-issue-embedding');
      expect(args.tenantId).toBe(TEST_TENANT_ID);
    });
  });
});

// PR feat/asset-multi-project-linking (2026-05-09 / Phase 1):
//   M:N 紐付けの link/unlink ユニット。Knowledge の linkKnowledgeToProject と同設計。
describe('linkRiskToProject', () => {
  beforeEach(() => vi.clearAllMocks());

  it('新規紐付け → added=true で M:N 行作成', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      id: 'r-1',
      tenantId: TEST_TENANT_ID,
      visibility: 'public',
    } as never);
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-2',
      tenantId: TEST_TENANT_ID,
    } as never);
    vi.mocked(prisma.riskIssueProject.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.riskIssueProject.create).mockResolvedValue({} as never);

    const result = await linkRiskToProject('r-1', 'p-2');
    expect(result).toEqual({ added: true });
    expect(prisma.riskIssueProject.create).toHaveBeenCalledWith({
      data: { riskIssueId: 'r-1', projectId: 'p-2' },
    });
  });

  it('既存紐付けあり → added=false で create を呼ばない (idempotent)', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      id: 'r-1',
      tenantId: TEST_TENANT_ID,
      visibility: 'public',
    } as never);
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-2',
      tenantId: TEST_TENANT_ID,
    } as never);
    vi.mocked(prisma.riskIssueProject.findUnique).mockResolvedValue({ id: 'rp-1' } as never);

    const result = await linkRiskToProject('r-1', 'p-2');
    expect(result).toEqual({ added: false });
    expect(prisma.riskIssueProject.create).not.toHaveBeenCalled();
  });

  it('リスク不存在 → NOT_FOUND', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-2',
      tenantId: TEST_TENANT_ID,
    } as never);
    await expect(linkRiskToProject('r-X', 'p-2')).rejects.toThrow('NOT_FOUND');
  });

  it('プロジェクト不存在 → PROJECT_NOT_FOUND', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      id: 'r-1',
      tenantId: TEST_TENANT_ID,
      visibility: 'public',
    } as never);
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null);
    await expect(linkRiskToProject('r-1', 'p-X')).rejects.toThrow('PROJECT_NOT_FOUND');
  });

  it('テナント不一致 → TENANT_MISMATCH (テナント越境ガード)', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      id: 'r-1',
      tenantId: TEST_TENANT_ID,
      visibility: 'public',
    } as never);
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-X',
      tenantId: '00000000-0000-0000-0000-other-tenant-id',
    } as never);
    await expect(linkRiskToProject('r-1', 'p-X')).rejects.toThrow('TENANT_MISMATCH');
  });
});

describe('unlinkRiskFromProject', () => {
  beforeEach(() => vi.clearAllMocks());

  it('既存紐付けあり → removed=true で delete', async () => {
    vi.mocked(prisma.riskIssueProject.findUnique).mockResolvedValue({ id: 'rp-1' } as never);
    vi.mocked(prisma.riskIssueProject.delete).mockResolvedValue({} as never);

    const result = await unlinkRiskFromProject('r-1', 'p-2', TEST_TENANT_ID);
    expect(result).toEqual({ removed: true });
    expect(prisma.riskIssueProject.delete).toHaveBeenCalledWith({ where: { id: 'rp-1' } });
  });

  it('紐付けなし → removed=false (idempotent)', async () => {
    vi.mocked(prisma.riskIssueProject.findUnique).mockResolvedValue(null);

    const result = await unlinkRiskFromProject('r-1', 'p-2', TEST_TENANT_ID);
    expect(result).toEqual({ removed: false });
    expect(prisma.riskIssueProject.delete).not.toHaveBeenCalled();
  });
});
