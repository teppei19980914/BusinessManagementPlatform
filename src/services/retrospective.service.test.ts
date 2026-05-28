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
    // PR feat/asset-multi-project-linking: M:N link/unlink
    retrospectiveProject: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    project: { findFirst: vi.fn() },
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
// 2026-05-24 (UI_PATTERNS §35 embedding 追補): bulkUpdateRetrospectivesVisibilityFromList が batch helper を呼ぶ
vi.mock('./embedding.service', () => ({
  generateAndPersistEntityEmbedding: vi.fn().mockResolvedValue(undefined),
  generateAndPersistBatchEmbeddings: vi.fn().mockResolvedValue({ generated: 0, failed: 0, costJpy: 0 }),
}));

// feat/asset-assignee-expansion (2026-05-26): クロステナント assigneeId 検証 mock
vi.mock('@/lib/assignee-validation', () => ({
  assertAssigneeTenant: vi.fn().mockResolvedValue(undefined),
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
  linkRetrospectiveToProject,
  unlinkRetrospectiveFromProject,
} from './retrospective.service';
import { prisma } from '@/lib/db';
import { generateAndPersistEntityEmbedding, generateAndPersistBatchEmbeddings } from './embedding.service';

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
  // feat/asset-assignee-expansion (2026-05-26)
  assigneeId: null,
  createdAt: now,
  updatedAt: now,
  // PR #199: comments は polymorphic comments テーブルへ移行 (DTO に含まれない)
  // PR feat/asset-multi-project-linking: M:N 紐付け済 (作成元のみ)
  retrospectiveProjects: [{ projectId: 'p-1' }],
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

    const r = await listAllRetrospectivesForViewer('admin-1', 'admin', 'tenant-A');

    expect(r[0].projectName).toBe('PJ');
    expect(r[0].createdByName).toBe('Alice');
  });

  it('非メンバーは projectName / createdByName を null', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([]);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      { ...retRow(), project: { id: 'p-1', name: 'PJ', deletedAt: null } },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    const r = await listAllRetrospectivesForViewer('u-99', 'general', 'tenant-A');

    expect(r[0].projectName).toBe(null);
    expect(r[0].createdByName).toBe(null);
    expect(r[0].canAccessProject).toBe(false);
  });

  it('admin に削除済みプロジェクトは projectDeleted=true', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      { ...retRow(), project: { id: 'p-1', name: 'X', deletedAt: new Date() } },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    const r = await listAllRetrospectivesForViewer('admin-1', 'admin', 'tenant-A');

    expect(r[0].projectDeleted).toBe(true);
    expect(r[0].canAccessProject).toBe(false);
  });

  it('2026-04-25: visibility フィルタは admin/非 admin 共に public 固定 (全○○ には draft を含めない)', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([]);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    // 非 admin
    await listAllRetrospectivesForViewer('u-1', 'general', 'tenant-A');
    const generalCall = vi.mocked(prisma.retrospective.findMany).mock.calls[0][0];
    expect(generalCall.where.visibility).toBe('public');
    expect(generalCall.where).not.toHaveProperty('OR');

    vi.clearAllMocks();
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    // admin (旧仕様では visibility 制約なしだったが要件変更で admin も public 固定)
    await listAllRetrospectivesForViewer('admin-1', 'admin', 'tenant-A');
    const adminCall = vi.mocked(prisma.retrospective.findMany).mock.calls[0][0];
    expect(adminCall.where.visibility).toBe('public');
  });

  // feat/crud-permission-redesign (2026-05-20): severity-1 情報漏洩修正の回帰防止。
  //   旧実装は linkedProjects[].name を非 ProjectMember にも露出していた。
  //   per-link で memberProjectIds を判定し、メンバー外プロジェクトの name を null にする。
  it('linkedProjects: per-link gate (非メンバーは全 name=null)', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([]);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      {
        ...retRow(),
        project: { id: 'p-1', name: 'PJ-1', deletedAt: null },
        retrospectiveProjects: [
          { projectId: 'p-1', project: { id: 'p-1', name: 'PJ-1', deletedAt: null } },
          { projectId: 'p-2', project: { id: 'p-2', name: 'PJ-2', deletedAt: null } },
        ],
      },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    const r = await listAllRetrospectivesForViewer('u-99', 'general', 'tenant-A');

    expect(r[0].linkedProjects).toHaveLength(2);
    expect(r[0].linkedProjects[0]).toMatchObject({ id: 'p-1', name: null });
    expect(r[0].linkedProjects[1]).toMatchObject({ id: 'p-2', name: null });
  });

  it('linkedProjects: per-link gate (一部のみメンバー → メンバー側のみ name 表示)', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([
      { projectId: 'p-1' },
    ] as never);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      {
        ...retRow(),
        project: { id: 'p-1', name: 'PJ-1', deletedAt: null },
        retrospectiveProjects: [
          { projectId: 'p-1', project: { id: 'p-1', name: 'PJ-1', deletedAt: null } },
          { projectId: 'p-2', project: { id: 'p-2', name: 'PJ-2', deletedAt: null } },
        ],
      },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    const r = await listAllRetrospectivesForViewer('u-1', 'general', 'tenant-A');

    expect(r[0].linkedProjects[0]).toMatchObject({ id: 'p-1', name: 'PJ-1' });
    expect(r[0].linkedProjects[1]).toMatchObject({ id: 'p-2', name: null });
  });

  it('linkedProjects: admin は全 name 表示 (per-link gate 対象外)', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      {
        ...retRow(),
        project: { id: 'p-1', name: 'PJ-1', deletedAt: null },
        retrospectiveProjects: [
          { projectId: 'p-1', project: { id: 'p-1', name: 'PJ-1', deletedAt: null } },
          { projectId: 'p-2', project: { id: 'p-2', name: 'PJ-2', deletedAt: null } },
        ],
      },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    const r = await listAllRetrospectivesForViewer('admin-1', 'admin', 'tenant-A');

    expect(r[0].linkedProjects[0]).toMatchObject({ id: 'p-1', name: 'PJ-1' });
    expect(r[0].linkedProjects[1]).toMatchObject({ id: 'p-2', name: 'PJ-2' });
  });
});

describe('createRetrospective', () => {
  beforeEach(() => vi.clearAllMocks());

  // ★severity-1 regression (fix/tenant-id-default-removal, 2026-05-28, ADR-0024):
  //   旧バグでは createRetrospective が tenantId を data に渡しておらず、schema の DB DEFAULT
  //   ('00000000-...-001') で silent に Default テナントへ混入していた。
  //   本テストは「指定された tenantId が data に明示的に含まれる」ことを保証する。
  it('★severity-1 regression: tenantId が data に明示的に渡される (Default テナント silent 混入の防止)', async () => {
    vi.mocked(prisma.retrospective.create).mockResolvedValue(retRow() as never);
    const OTHER_TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await createRetrospective(
      'p-1',
      {
        conductedDate: '2026-04-01',
        planSummary: '',
        actualSummary: '',
        goodPoints: '',
        problems: '',
        improvements: '',
        knowledgeToShare: null,
      } as never,
      'u-1',
      OTHER_TENANT_ID,
    );
    expect(prisma.retrospective.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: OTHER_TENANT_ID }),
      }),
    );
  });

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
    vi.mocked(prisma.retrospective.create).mockResolvedValue(retRow({ id: 'ret-new', visibility: 'public' }) as never);

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
        visibility: 'public',
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

  // PR #357 (2026-05-14): visibility=draft なら embedding 生成しない
  it('createRetrospective: visibility=draft なら embedding を生成しない (Voyage API 課金を発生させない)', async () => {
    vi.mocked(prisma.retrospective.create).mockResolvedValue(retRow({ id: 'ret-draft', visibility: 'draft' }) as never);
    await createRetrospective(
      'p-1',
      {
        conductedDate: '2026-04-01',
        planSummary: '計画', actualSummary: '実績', goodPoints: 'g', problems: 'p',
        improvements: 'i', knowledgeToShare: null,
        visibility: 'draft',
      } as never,
      'u-1',
      TEST_TENANT_ID,
    );
    expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
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

  it('作成者でも担当者でもない (admin でも) は FORBIDDEN', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue(
      { createdBy: 'u-1', assigneeId: null } as never,
    );
    await expect(
      updateRetrospective('ret-1', { planSummary: 'n' }, 'u-other', TEST_TENANT_ID),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      updateRetrospective('ret-1', { planSummary: 'n' }, 'admin-x', TEST_TENANT_ID),
    ).rejects.toThrow('FORBIDDEN');
  });

  // feat/asset-assignee-expansion (2026-05-26): 担当者も update 可能
  it('担当者 (assigneeId === userId) は update 可能', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue(
      { createdBy: 'u-creator', assigneeId: 'u-assignee', visibility: 'draft' } as never,
    );
    vi.mocked(prisma.retrospective.update).mockResolvedValue(retRow() as never);

    await updateRetrospective('ret-1', { planSummary: 'updated' }, 'u-assignee', TEST_TENANT_ID);

    const call = vi.mocked(prisma.retrospective.update).mock.calls[0][0];
    expect(call.data.planSummary).toBe('updated');
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

  it('updateRetrospective: text フィールド非変更 (state/visibility 維持のみ) は embedding 再生成しない', async () => {
    // PR #357: 既存 visibility=public 維持なら text 変更なしで再生成しない
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({
      createdBy: 'u-1', visibility: 'public',
    } as never);
    vi.mocked(prisma.retrospective.update).mockResolvedValue(retRow() as never);

    await updateRetrospective(
      'ret-1',
      { state: 'confirmed', visibility: 'public' },
      'u-1',
      TEST_TENANT_ID,
    );

    expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
  });

  // ================================================================
  // PR #357 (2026-05-14): visibility 状態遷移 × embedding 生成マトリクス
  // ================================================================
  describe('PR #357: visibility 状態遷移 × embedding 生成判定', () => {
    const baseExisting = {
      createdBy: 'u-1',
      planSummary: '既存計画',
      actualSummary: '既存実績',
      goodPoints: '既存good',
      problems: '既存prob',
      improvements: '既存imp',
      knowledgeToShare: null,
    };

    it('draft → draft (text 変更あり) → 呼ばれない (draft は提案候補外なので課金しない)', async () => {
      vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({
        ...baseExisting, visibility: 'draft',
      } as never);
      vi.mocked(prisma.retrospective.update).mockResolvedValue(retRow({ visibility: 'draft' }) as never);
      await updateRetrospective('ret-1', { planSummary: '新', visibility: 'draft' }, 'u-1', TEST_TENANT_ID);
      expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
    });

    it('draft → public (text 変更なし) → 呼ばれる (公開化時の初回生成)', async () => {
      vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({
        ...baseExisting, visibility: 'draft',
      } as never);
      vi.mocked(prisma.retrospective.update).mockResolvedValue(retRow({ visibility: 'public' }) as never);
      await updateRetrospective('ret-1', { visibility: 'public' }, 'u-1', TEST_TENANT_ID);
      expect(generateAndPersistEntityEmbedding).toHaveBeenCalledTimes(1);
    });

    it('public → draft (text 変更あり) → 呼ばれない (既存 embedding は保持)', async () => {
      vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({
        ...baseExisting, visibility: 'public',
      } as never);
      vi.mocked(prisma.retrospective.update).mockResolvedValue(retRow({ visibility: 'draft' }) as never);
      await updateRetrospective(
        'ret-1',
        { planSummary: '新', visibility: 'draft' },
        'u-1',
        TEST_TENANT_ID,
      );
      expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
    });
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
    await expect(
      deleteRetrospective('x', 'u-1', 'general', 'tenant-A', 'project'),
    ).rejects.toThrow('NOT_FOUND');
  });

  // feat/crud-permission-redesign (2026-05-20): context 別に削除権限が変わる
  it('delete (context=project): 作成者本人は削除 OK', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    vi.mocked(prisma.retrospective.update).mockResolvedValue({} as never);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 0 } as never);
    await deleteRetrospective('ret-1', 'u-1', 'general', 'tenant-A', 'project');

    expect(prisma.retrospective.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });

  it('delete (context=project): admin も他人作成は FORBIDDEN', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    await expect(
      deleteRetrospective('ret-1', 'admin-x', 'admin', 'tenant-A', 'project'),
    ).rejects.toThrow('FORBIDDEN');
    expect(prisma.retrospective.update).not.toHaveBeenCalled();
  });

  it('delete (context=global): admin は他人作成も削除可 (管理削除)', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    vi.mocked(prisma.retrospective.update).mockResolvedValue({} as never);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 0 } as never);
    await deleteRetrospective('ret-1', 'admin-x', 'admin', 'tenant-A', 'global');
    expect(prisma.retrospective.update).toHaveBeenCalled();
  });

  it('delete (context=global): 非 admin (作成者本人) も FORBIDDEN', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({ createdBy: 'u-1' } as never);
    await expect(
      deleteRetrospective('ret-1', 'u-1', 'general', 'tenant-A', 'global'),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('delete (context=project): 非 admin の第三者は FORBIDDEN', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue(
      { createdBy: 'u-1', assigneeId: null } as never,
    );
    await expect(
      deleteRetrospective('ret-1', 'u-other', 'general', 'tenant-A', 'project'),
    ).rejects.toThrow('FORBIDDEN');
  });

  // feat/asset-assignee-expansion (2026-05-26): 担当者も削除可能 (project context)
  it('delete (context=project): 担当者は削除可能', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue(
      { createdBy: 'u-creator', assigneeId: 'u-assignee' } as never,
    );
    vi.mocked(prisma.retrospective.update).mockResolvedValue({} as never);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 0 } as never);

    await deleteRetrospective('ret-1', 'u-assignee', 'general', 'tenant-A', 'project');

    expect(prisma.retrospective.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
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
      retrospectiveProjects: [{ projectId: 'p-1' }],
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
      retrospectiveProjects: [{ projectId: 'p-1' }],
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
      retrospectiveProjects: [{ projectId: 'p-1' }],
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
    const r = await bulkUpdateRetrospectivesVisibilityFromList('p-1', [], 'draft', 'u-1', TEST_TENANT_ID);
    expect(r).toEqual({ updatedIds: [], skippedNotOwned: 0, skippedNotFound: 0, embeddingsGenerated: 0 });
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
      't-1', // viewerTenantId
    );

    expect(r.updatedIds).toEqual(['ret-1', 'ret-3']);
    expect(r.skippedNotOwned).toBe(1);
    expect(r.skippedNotFound).toBe(0);

    // PR feat/asset-multi-project-linking: scope は M:N (retrospectiveProjects) 経由で判定する。
    // 2026-05-12: findMany にも tenantId 含まれる
    const findCall = vi.mocked(prisma.retrospective.findMany).mock.calls[0][0];
    expect(findCall.where).toMatchObject({
      id: { in: ['ret-1', 'ret-2', 'ret-3'] },
      deletedAt: null,
      tenantId: 't-1',
      retrospectiveProjects: { some: { projectId: 'p-1' } },
    });

    // 2026-05-12 severity-1 防御: tenantId / 作成者 OR 担当者 明示
    // feat/asset-assignee-expansion (2026-05-26): OR 句で「作成者 OR 担当者」を再検証
    const call = vi.mocked(prisma.retrospective.updateMany).mock.calls[0][0];
    expect(call.where).toMatchObject({
      id: { in: ['ret-1', 'ret-3'] },
      tenantId: 't-1',
      OR: [
        { createdBy: 'u-1' },
        { assigneeId: 'u-1' },
      ],
    });
    expect(call.data).toEqual({ visibility: 'draft', updatedBy: 'u-1' });
  });

  // feat/asset-assignee-expansion (2026-05-26): 担当者も bulk visibility 更新対象
  it('担当者本人のレコードも bulk 更新対象に含まれる', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      { id: 'ret-1', createdBy: 'u-creator', assigneeId: 'u-1' }, // u-1 が担当者
      { id: 'ret-2', createdBy: 'u-1', assigneeId: null },        // u-1 が作成者
      { id: 'ret-3', createdBy: 'u-OTHER', assigneeId: 'u-OTHER' }, // 第3者
    ] as never);
    vi.mocked(prisma.retrospective.updateMany).mockResolvedValue({ count: 2 } as never);
    const r = await bulkUpdateRetrospectivesVisibilityFromList(
      'p-1', ['ret-1', 'ret-2', 'ret-3'], 'public', 'u-1', 't-1',
    );
    expect(r.updatedIds).toEqual(['ret-1', 'ret-2']);
    expect(r.skippedNotOwned).toBe(1);
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
    const r = await bulkUpdateRetrospectivesVisibilityFromList('p-1', ['ret-1'], 'draft', 'u-1', TEST_TENANT_ID);
    expect(r.updatedIds).toEqual([]);
    expect(r.skippedNotOwned).toBe(1);
    expect(prisma.retrospective.updateMany).not.toHaveBeenCalled();
  });

  // UI_PATTERNS §35 (2026-05-24): bulk visibility 経路の embedding コスト最適化テスト。
  describe('embedding 生成 (コスト最適化)', () => {
    it('visibility=draft への変更は embedding を生成しない (Voyage 課金回避)', async () => {
      vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
        { id: 'ret-1', createdBy: 'u-1', visibility: 'public', planSummary: 'p', actualSummary: 'a', goodPoints: 'g', problems: 'pr', improvements: 'i', knowledgeToShare: null },
      ] as never);
      vi.mocked(prisma.retrospective.updateMany).mockResolvedValue({ count: 1 } as never);

      const r = await bulkUpdateRetrospectivesVisibilityFromList('p-1', ['ret-1'], 'draft', 'u-1', TEST_TENANT_ID);
      expect(r.embeddingsGenerated).toBe(0);
      expect(generateAndPersistBatchEmbeddings).not.toHaveBeenCalled();
    });

    it('public→public のままなら embedding を生成しない', async () => {
      vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
        { id: 'ret-1', createdBy: 'u-1', visibility: 'public', planSummary: 'p', actualSummary: 'a', goodPoints: 'g', problems: 'pr', improvements: 'i', knowledgeToShare: null },
      ] as never);
      vi.mocked(prisma.retrospective.updateMany).mockResolvedValue({ count: 1 } as never);

      const r = await bulkUpdateRetrospectivesVisibilityFromList('p-1', ['ret-1'], 'public', 'u-1', TEST_TENANT_ID);
      expect(r.embeddingsGenerated).toBe(0);
      expect(generateAndPersistBatchEmbeddings).not.toHaveBeenCalled();
    });

    it('draft→public 遷移行のみ batch で 1 ApiCallLog 集約', async () => {
      vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
        { id: 'ret-1', createdBy: 'u-1', visibility: 'draft', planSummary: 'p1', actualSummary: 'a1', goodPoints: 'g1', problems: 'pr1', improvements: 'i1', knowledgeToShare: null },
        { id: 'ret-2', createdBy: 'u-1', visibility: 'public', planSummary: 'p2', actualSummary: 'a2', goodPoints: 'g2', problems: 'pr2', improvements: 'i2', knowledgeToShare: null },
      ] as never);
      vi.mocked(prisma.retrospective.updateMany).mockResolvedValue({ count: 2 } as never);
      vi.mocked(generateAndPersistBatchEmbeddings).mockResolvedValue({ generated: 1, failed: 0, costJpy: 1 });

      const r = await bulkUpdateRetrospectivesVisibilityFromList('p-1', ['ret-1', 'ret-2'], 'public', 'u-1', TEST_TENANT_ID);

      expect(r.embeddingsGenerated).toBe(1);
      expect(generateAndPersistBatchEmbeddings).toHaveBeenCalledTimes(1);
      const args = vi.mocked(generateAndPersistBatchEmbeddings).mock.calls[0][0];
      expect(args.items.map((i) => i.rowId)).toEqual(['ret-1']);
      expect(args.featureUnit).toBe('retrospective-embedding');
    });
  });
});

// PR feat/asset-multi-project-linking: M:N link/unlink ユニット
describe('linkRetrospectiveToProject', () => {
  beforeEach(() => vi.clearAllMocks());

  it('新規紐付け → added=true で M:N 行作成', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({
      id: 'ret-1',
      tenantId: TEST_TENANT_ID,
    } as never);
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-2',
      tenantId: TEST_TENANT_ID,
    } as never);
    vi.mocked(prisma.retrospectiveProject.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.retrospectiveProject.create).mockResolvedValue({} as never);

    const result = await linkRetrospectiveToProject('ret-1', 'p-2');
    expect(result).toEqual({ added: true });
    expect(prisma.retrospectiveProject.create).toHaveBeenCalledWith({
      data: { retrospectiveId: 'ret-1', projectId: 'p-2' },
    });
  });

  it('既存紐付けあり → added=false (idempotent)', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({
      id: 'ret-1',
      tenantId: TEST_TENANT_ID,
    } as never);
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-2',
      tenantId: TEST_TENANT_ID,
    } as never);
    vi.mocked(prisma.retrospectiveProject.findUnique).mockResolvedValue({ id: 'rp-1' } as never);

    const result = await linkRetrospectiveToProject('ret-1', 'p-2');
    expect(result).toEqual({ added: false });
    expect(prisma.retrospectiveProject.create).not.toHaveBeenCalled();
  });

  it('テナント不一致 → TENANT_MISMATCH', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({
      id: 'ret-1',
      tenantId: TEST_TENANT_ID,
    } as never);
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-X',
      tenantId: '00000000-0000-0000-0000-other-tenant',
    } as never);
    await expect(linkRetrospectiveToProject('ret-1', 'p-X')).rejects.toThrow('TENANT_MISMATCH');
  });
});

describe('unlinkRetrospectiveFromProject', () => {
  beforeEach(() => vi.clearAllMocks());

  it('既存紐付けあり → removed=true で delete', async () => {
    vi.mocked(prisma.retrospectiveProject.findUnique).mockResolvedValue({ id: 'rp-1' } as never);
    vi.mocked(prisma.retrospectiveProject.delete).mockResolvedValue({} as never);

    const result = await unlinkRetrospectiveFromProject('ret-1', 'p-2');
    expect(result).toEqual({ removed: true });
  });

  it('紐付けなし → removed=false (idempotent)', async () => {
    vi.mocked(prisma.retrospectiveProject.findUnique).mockResolvedValue(null);

    const result = await unlinkRetrospectiveFromProject('ret-1', 'p-2');
    expect(result).toEqual({ removed: false });
  });
});
