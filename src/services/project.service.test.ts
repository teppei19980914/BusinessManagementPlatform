import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    project: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
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
    await updateProject('p-1', { customerId: 'cust-new' }, 'u-1');
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
    await updateProject('p-1', { name: 'new' }, 'u-1');

    const call = vi.mocked(prisma.project.update).mock.calls[0][0];
    expect(call.data.name).toBe('new');
    expect(call.data.purpose).toBeUndefined();
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
