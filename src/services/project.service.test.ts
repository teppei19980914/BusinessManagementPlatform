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
    riskIssue: { deleteMany: vi.fn() },
    retrospective: { findMany: vi.fn(), deleteMany: vi.fn() },
    retrospectiveComment: { deleteMany: vi.fn() },
    knowledgeProject: {
      findMany: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    knowledge: { delete: vi.fn() },
    task: { findMany: vi.fn(), deleteMany: vi.fn() },
    taskProgressLog: { deleteMany: vi.fn() },
    estimate: { deleteMany: vi.fn() },
    projectMember: { deleteMany: vi.fn() },
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
  customerName: 'Cust',
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

  it('keyword でフィルタ (name/customerName/purpose の OR)', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([]);
    vi.mocked(prisma.project.count).mockResolvedValue(0);

    await listProjects({ keyword: 'searchword' }, 'admin-1', 'admin');

    const call = vi.mocked(prisma.project.findMany).mock.calls[0][0];
    expect(call.where.OR).toHaveLength(3);
  });

  it('limit 上限 100, ページング', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([]);
    vi.mocked(prisma.project.count).mockResolvedValue(0);

    await listProjects({ limit: 999, page: 3 }, 'admin-1', 'admin');

    const call = vi.mocked(prisma.project.findMany).mock.calls[0][0];
    expect(call.take).toBe(100);
    expect(call.skip).toBe(200);
  });

  it('customerName パラメータは contains でフィルタ', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([]);
    vi.mocked(prisma.project.count).mockResolvedValue(0);

    await listProjects({ customerName: 'ACME' }, 'admin-1', 'admin');

    const call = vi.mocked(prisma.project.findMany).mock.calls[0][0];
    expect(call.where.customerName).toEqual({ contains: 'ACME', mode: 'insensitive' });
  });
});

describe('createProject / getProject / updateProject / deleteProject', () => {
  beforeEach(() => vi.clearAllMocks());

  it('createProject: 日付 ISO を Date に変換、status=planning', async () => {
    vi.mocked(prisma.project.create).mockResolvedValue(pRow() as never);

    await createProject(
      {
        name: 'x',
        customerName: 'y',
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
    await deleteProject('p-1', 'u-1');

    expect(prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
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

describe('deleteProjectCascade', () => {
  beforeEach(() => vi.clearAllMocks());

  it('紐付くリスク/振り返り/タスク/メンバーを物理削除し、count を返す', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      { id: 'ret-1' },
    ] as never);
    vi.mocked(prisma.riskIssue.deleteMany).mockResolvedValue({ count: 3 } as never);
    vi.mocked(prisma.retrospective.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.retrospectiveComment.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.knowledgeProject.findMany).mockResolvedValue([]);
    vi.mocked(prisma.task.findMany).mockResolvedValue([]);
    vi.mocked(prisma.task.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.estimate.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.projectMember.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.project.delete).mockResolvedValue({} as never);

    const r = await deleteProjectCascade('p-1');

    expect(r.risks).toBe(3);
    expect(r.retrospectives).toBe(1);
    expect(prisma.project.delete).toHaveBeenCalledWith({ where: { id: 'p-1' } });
  });

  it('他プロジェクトと共有されるナレッジは unlink (knowledge.delete 呼ばない)', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
    vi.mocked(prisma.riskIssue.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.retrospective.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.knowledgeProject.findMany).mockResolvedValue([
      { knowledgeId: 'k-1' },
    ] as never);
    vi.mocked(prisma.knowledgeProject.count).mockResolvedValue(3); // 3 プロジェクトで共有
    vi.mocked(prisma.knowledgeProject.delete).mockResolvedValue({} as never);
    vi.mocked(prisma.task.findMany).mockResolvedValue([]);
    vi.mocked(prisma.task.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.estimate.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.projectMember.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.project.delete).mockResolvedValue({} as never);

    const r = await deleteProjectCascade('p-1');

    expect(r.knowledgeUnlinked).toBe(1);
    expect(r.knowledgeDeleted).toBe(0);
    expect(prisma.knowledge.delete).not.toHaveBeenCalled();
  });

  it('単独紐付けのナレッジは物理削除', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
    vi.mocked(prisma.riskIssue.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.retrospective.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.knowledgeProject.findMany).mockResolvedValue([
      { knowledgeId: 'k-1' },
    ] as never);
    vi.mocked(prisma.knowledgeProject.count).mockResolvedValue(1); // このプロジェクトだけ
    vi.mocked(prisma.knowledgeProject.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.knowledge.delete).mockResolvedValue({} as never);
    vi.mocked(prisma.task.findMany).mockResolvedValue([]);
    vi.mocked(prisma.task.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.estimate.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.projectMember.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.project.delete).mockResolvedValue({} as never);

    const r = await deleteProjectCascade('p-1');

    expect(r.knowledgeDeleted).toBe(1);
    expect(r.knowledgeUnlinked).toBe(0);
    expect(prisma.knowledge.delete).toHaveBeenCalledWith({ where: { id: 'k-1' } });
  });
});
