import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    riskIssue: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    projectMember: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

import {
  listRisks,
  listAllRisksForViewer,
  getRisk,
  createRisk,
  updateRisk,
  deleteRisk,
  risksToCSV,
  type RiskDTO,
} from './risk.service';
import { prisma } from '@/lib/db';

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

  it('admin は全リスクをフィルタなしで取得', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([rRow()] as never);

    await listRisks('p-1', 'admin-id', 'admin');

    expect(prisma.riskIssue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: 'p-1', deletedAt: null }),
      }),
    );
    const call = vi.mocked(prisma.riskIssue.findMany).mock.calls[0][0];
    expect(call.where).not.toHaveProperty('OR');
  });

  it('非 admin は public + 自身の draft のみ (OR 条件)', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([]);
    await listRisks('p-1', 'u-1', 'general');
    const call = vi.mocked(prisma.riskIssue.findMany).mock.calls[0][0];
    expect(call.where.OR).toEqual([
      { visibility: 'public' },
      { visibility: 'draft', reporterId: 'u-1' },
    ]);
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

    const r = await listAllRisksForViewer('admin-1', 'admin');

    expect(r[0].projectName).toBe('PJ A');
    expect(r[0].reporterName).toBe('Alice');
    expect(r[0].canAccessProject).toBe(true);
  });

  it('非 admin & 非メンバーは projectName / 氏名をマスク', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([]);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      { ...rRow(), project: { id: 'p-1', name: 'PJ A', deletedAt: null } },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    const r = await listAllRisksForViewer('u-99', 'general');

    expect(r[0].projectName).toBe(null);
    expect(r[0].reporterName).toBe(null);
    expect(r[0].canAccessProject).toBe(false);
    expect(r[0].projectDeleted).toBe(false); // admin 以外には秘匿
  });

  it('admin には削除済みプロジェクトの projectDeleted=true が見える', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      { ...rRow(), project: { id: 'p-1', name: 'Gone', deletedAt: new Date() } },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    const r = await listAllRisksForViewer('admin-1', 'admin');

    expect(r[0].projectDeleted).toBe(true);
    expect(r[0].canAccessProject).toBe(false); // deleted なのでリンク不可
  });
});

describe('getRisk', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在しなければ null', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(null);
    expect(await getRisk('x')).toBe(null);
  });

  it('存在すれば DTO', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(rRow() as never);
    const r = await getRisk('r-1');
    expect(r?.id).toBe('r-1');
  });
});

describe('createRisk', () => {
  beforeEach(() => vi.clearAllMocks());

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
    );
    const call = vi.mocked(prisma.riskIssue.create).mock.calls[0][0];
    expect(call.data.riskNature).toBe(null);
  });

  it('priority 未指定時は impact を流用 (PR #63)', async () => {
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
    );
    const call = vi.mocked(prisma.riskIssue.create).mock.calls[0][0];
    expect(call.data.priority).toBe('high');
  });
});

describe('updateRisk', () => {
  beforeEach(() => vi.clearAllMocks());

  it('指定フィールドのみ data に積む', async () => {
    vi.mocked(prisma.riskIssue.update).mockResolvedValue(rRow() as never);

    await updateRisk('r-1', { title: 'new', state: 'resolved' }, 'u-1');

    const call = vi.mocked(prisma.riskIssue.update).mock.calls[0][0];
    expect(call.data.title).toBe('new');
    expect(call.data.state).toBe('resolved');
    expect(call.data.updatedBy).toBe('u-1');
    expect(call.data.content).toBeUndefined();
  });

  it('deadline 文字列を Date に変換する', async () => {
    vi.mocked(prisma.riskIssue.update).mockResolvedValue(rRow() as never);

    await updateRisk('r-1', { deadline: '2026-06-01' }, 'u-1');

    const call = vi.mocked(prisma.riskIssue.update).mock.calls[0][0];
    expect(call.data.deadline).toBeInstanceOf(Date);
  });
});

describe('deleteRisk', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletedAt をセット (論理削除)', async () => {
    vi.mocked(prisma.riskIssue.update).mockResolvedValue({} as never);

    await deleteRisk('r-1', 'u-1');

    expect(prisma.riskIssue.update).toHaveBeenCalledWith({
      where: { id: 'r-1' },
      data: { deletedAt: expect.any(Date), updatedBy: 'u-1' },
    });
  });
});

describe('risksToCSV', () => {
  const base = (o: Partial<RiskDTO> = {}): RiskDTO => ({
    id: 'r',
    projectId: 'p',
    type: 'risk',
    title: 'タイトル',
    content: '',
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
