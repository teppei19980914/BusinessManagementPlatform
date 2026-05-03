import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    riskIssue: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      // PR #161 / PR #165: bulkUpdateRisksFromList で使用
      updateMany: vi.fn(),
    },
    projectMember: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    // PR #89: deleteRisk が attachment.updateMany を $transaction 内で呼ぶ
    attachment: { updateMany: vi.fn() },
    // PR fix/visibility-auth-matrix: deleteRisk が comment.updateMany を $transaction 内で呼ぶ
    comment: { updateMany: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

// PR #5-c (T-03 Phase 2): createRisk / updateRisk から呼ばれる embedding helper をモック
vi.mock('./embedding.service', () => ({
  generateAndPersistEntityEmbedding: vi.fn().mockResolvedValue(undefined),
}));

import {
  listRisks,
  listAllRisksForViewer,
  getRisk,
  createRisk,
  updateRisk,
  deleteRisk,
  bulkUpdateRisksFromList,
  risksToCSV,
  type RiskDTO,
} from './risk.service';
import { prisma } from '@/lib/db';
import { generateAndPersistEntityEmbedding } from './embedding.service';

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

  it('非 admin は public + 自分の draft (2026-05-01 仕様変更: 自分の draft は表示)', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([]);
    await listRisks('p-1', 'u-1', 'general');
    const call = vi.mocked(prisma.riskIssue.findMany).mock.calls[0][0];
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

    const r = await listAllRisksForViewer('admin-1', 'admin');

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

    const r = await listAllRisksForViewer('u-99', 'general');

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

    const r = await listAllRisksForViewer('admin-1', 'admin');

    expect(r[0].projectDeleted).toBe(true);
    expect(r[0].canAccessProject).toBe(false); // deleted なのでリンク不可
  });

  it('2026-04-25: visibility フィルタは admin/非 admin 共に public 固定 (全○○ には draft を含めない)', async () => {
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([]);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    // 非 admin
    await listAllRisksForViewer('u-1', 'general');
    const generalCall = vi.mocked(prisma.riskIssue.findMany).mock.calls[0][0];
    expect(generalCall.where.visibility).toBe('public');
    expect(generalCall.where).not.toHaveProperty('OR');

    vi.clearAllMocks();
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    // admin (旧仕様: visibility 制約なし → 要件変更で admin も public 固定。
    // admin が draft を管理削除したい場合はプロジェクト個別画面から行う)
    await listAllRisksForViewer('admin-1', 'admin');
    const adminCall = vi.mocked(prisma.riskIssue.findMany).mock.calls[0][0];
    expect(adminCall.where.visibility).toBe('public');
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
    const call = vi.mocked(prisma.riskIssue.create).mock.calls[0][0];
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
    const call = vi.mocked(prisma.riskIssue.create).mock.calls[0][0];
    expect(call.data.priority).toBe('low');
  });

  it('PR-γ: risk 高/高 → high', async () => {
    vi.mocked(prisma.riskIssue.create).mockResolvedValue(rRow() as never);
    await createRisk('p-1', {
      type: 'risk', title: 't', content: 'c', impact: 'high', likelihood: 'high',
      assigneeId: null, deadline: null, visibility: 'draft',
    } as never, 'u-1', TEST_TENANT_ID);
    expect(vi.mocked(prisma.riskIssue.create).mock.calls[0][0].data.priority).toBe('high');
  });

  it('PR-γ: risk 低/低 → minimal', async () => {
    vi.mocked(prisma.riskIssue.create).mockResolvedValue(rRow() as never);
    await createRisk('p-1', {
      type: 'risk', title: 't', content: 'c', impact: 'low', likelihood: 'low',
      assigneeId: null, deadline: null, visibility: 'draft',
    } as never, 'u-1', TEST_TENANT_ID);
    expect(vi.mocked(prisma.riskIssue.create).mock.calls[0][0].data.priority).toBe('minimal');
  });

  it('PR-γ: issue 重要度高/緊急度低 → medium (重要度重視)', async () => {
    vi.mocked(prisma.riskIssue.create).mockResolvedValue(rRow() as never);
    await createRisk('p-1', {
      type: 'issue', title: 't', content: 'c', impact: 'high', likelihood: 'low',
      assigneeId: null, deadline: null, visibility: 'draft',
    } as never, 'u-1', TEST_TENANT_ID);
    expect(vi.mocked(prisma.riskIssue.create).mock.calls[0][0].data.priority).toBe('medium');
  });

  it('PR-γ: issue 重要度低/緊急度高 → low (重要度重視: risk と逆転)', async () => {
    vi.mocked(prisma.riskIssue.create).mockResolvedValue(rRow() as never);
    await createRisk('p-1', {
      type: 'issue', title: 't', content: 'c', impact: 'low', likelihood: 'high',
      assigneeId: null, deadline: null, visibility: 'draft',
    } as never, 'u-1', TEST_TENANT_ID);
    expect(vi.mocked(prisma.riskIssue.create).mock.calls[0][0].data.priority).toBe('low');
  });

  // PR #5-c (T-03 Phase 2): 本体 INSERT 後に embedding helper が呼ばれる (fail-safe)
  it('createRisk: 本体作成後に generateAndPersistEntityEmbedding が呼ばれる', async () => {
    vi.mocked(prisma.riskIssue.create).mockResolvedValue(rRow({ id: 'r-new' }) as never);
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
    const args = vi.mocked(generateAndPersistEntityEmbedding).mock.calls[0][0];
    expect(args.table).toBe('risks_issues');
    expect(args.rowId).toBe('r-new');
    expect(args.tenantId).toBe(TEST_TENANT_ID);
    expect(args.userId).toBe('u-1');
    expect(args.featureUnit).toBe('risk-issue-embedding');
    expect(args.text).toContain('タイトル');
    expect(args.text).toContain('内容');
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

  it('作成者以外 (admin でも) は FORBIDDEN', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(
      { reporterId: 'u-1' } as never,
    );
    await expect(updateRisk('r-1', { title: 'new' }, 'u-other', TEST_TENANT_ID)).rejects.toThrow(
      'FORBIDDEN',
    );
    // admin であっても他人のリスクは編集不可
    await expect(updateRisk('r-1', { title: 'new' }, 'admin-x', TEST_TENANT_ID)).rejects.toThrow(
      'FORBIDDEN',
    );
  });

  it('作成者本人なら指定フィールドのみ data に積む', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ reporterId: 'u-1' } as never);
    vi.mocked(prisma.riskIssue.update).mockResolvedValue(rRow() as never);

    await updateRisk('r-1', { title: 'new', state: 'resolved' }, 'u-1', TEST_TENANT_ID);

    const call = vi.mocked(prisma.riskIssue.update).mock.calls[0][0];
    expect(call.data.title).toBe('new');
    expect(call.data.state).toBe('resolved');
    expect(call.data.updatedBy).toBe('u-1');
    expect(call.data.content).toBeUndefined();
  });

  it('deadline 文字列を Date に変換する', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ reporterId: 'u-1' } as never);
    vi.mocked(prisma.riskIssue.update).mockResolvedValue(rRow() as never);

    await updateRisk('r-1', { deadline: '2026-06-01' }, 'u-1', TEST_TENANT_ID);

    const call = vi.mocked(prisma.riskIssue.update).mock.calls[0][0];
    expect(call.data.deadline).toBeInstanceOf(Date);
  });

  // PR #5-c: text フィールド変更時のみ embedding 再生成 (LLM 課金回避)
  it('updateRisk: text フィールド変更時は embedding を再生成する', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ reporterId: 'u-1' } as never);
    vi.mocked(prisma.riskIssue.update).mockResolvedValue(rRow() as never);

    await updateRisk('r-1', { title: 'new title' }, 'u-1', TEST_TENANT_ID);

    expect(generateAndPersistEntityEmbedding).toHaveBeenCalledTimes(1);
    const args = vi.mocked(generateAndPersistEntityEmbedding).mock.calls[0][0];
    expect(args.table).toBe('risks_issues');
    expect(args.rowId).toBe('r-1');
    expect(args.tenantId).toBe(TEST_TENANT_ID);
  });

  it('updateRisk: text フィールド非変更 (state/assignee のみ) は embedding 再生成しない', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ reporterId: 'u-1' } as never);
    vi.mocked(prisma.riskIssue.update).mockResolvedValue(rRow() as never);

    await updateRisk('r-1', { state: 'resolved', assigneeId: 'u-2' }, 'u-1', TEST_TENANT_ID);

    expect(generateAndPersistEntityEmbedding).not.toHaveBeenCalled();
  });
});

describe('deleteRisk', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在しなければ NOT_FOUND', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(null);
    await expect(deleteRisk('x', 'u-1', 'general')).rejects.toThrow('NOT_FOUND');
  });

  it('作成者本人は削除できる', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ reporterId: 'u-1' } as never);
    vi.mocked(prisma.riskIssue.update).mockResolvedValue({} as never);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 0 } as never);

    await deleteRisk('r-1', 'u-1', 'general');

    expect(prisma.riskIssue.update).toHaveBeenCalledWith({
      where: { id: 'r-1' },
      data: { deletedAt: expect.any(Date), updatedBy: 'u-1' },
    });
  });

  it('admin は他人のリスクも削除できる (全リスク画面からの管理削除)', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ reporterId: 'u-1' } as never);
    vi.mocked(prisma.riskIssue.update).mockResolvedValue({} as never);
    vi.mocked(prisma.attachment.updateMany).mockResolvedValue({ count: 0 } as never);

    await deleteRisk('r-1', 'admin-x', 'admin');

    expect(prisma.riskIssue.update).toHaveBeenCalled();
  });

  it('非 admin の第三者は FORBIDDEN', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ reporterId: 'u-1' } as never);
    await expect(deleteRisk('r-1', 'u-other', 'general')).rejects.toThrow('FORBIDDEN');
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

// PR #161 (元 cross-list 用) → PR #165 で project-scoped に移し替え。
// プロジェクト「リスク/課題一覧」からの一括更新で、単発 updateRisk の reporter-only 認可を踏襲しつつ、
// updateMany で 1 クエリ化。他人のレコードを ids に混ぜても silently skip される ことを保証する。
// PR #165: where に projectId が必須化され、他プロジェクトの混入も skippedNotFound 扱い。
describe('bulkUpdateRisksFromList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ids が空配列なら updateMany を呼ばずに 0 件で返す', async () => {
    const r = await bulkUpdateRisksFromList('p-1', [], { state: 'resolved' }, 'u-1');
    expect(r).toEqual({ updatedIds: [], skippedNotOwned: 0, skippedNotFound: 0 });
    expect(prisma.riskIssue.updateMany).not.toHaveBeenCalled();
  });

  it('reporter 本人のレコードのみ updateMany される (他人の混入は skip)', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      { id: 'r-1', reporterId: 'u-1' },
      { id: 'r-2', reporterId: 'u-1' },
      { id: 'r-3', reporterId: 'u-OTHER' }, // 他人
    ] as never);
    vi.mocked(prisma.riskIssue.updateMany).mockResolvedValue({ count: 2 } as never);

    const r = await bulkUpdateRisksFromList(
      'p-1',
      ['r-1', 'r-2', 'r-3'],
      { state: 'resolved' },
      'u-1',
    );

    expect(r.updatedIds).toEqual(['r-1', 'r-2']);
    expect(r.skippedNotOwned).toBe(1);
    expect(r.skippedNotFound).toBe(0);

    // PR #165: findMany の where に projectId が含まれることを確認
    const findCall = vi.mocked(prisma.riskIssue.findMany).mock.calls[0][0];
    expect(findCall.where).toEqual({ id: { in: ['r-1', 'r-2', 'r-3'] }, projectId: 'p-1', deletedAt: null });

    const updateCall = vi.mocked(prisma.riskIssue.updateMany).mock.calls[0][0];
    expect(updateCall.where).toEqual({ id: { in: ['r-1', 'r-2'] } });
    expect(updateCall.data).toEqual({ updatedBy: 'u-1', state: 'resolved' });
  });

  it('存在しない / 削除済 / 別プロジェクトの id は skippedNotFound にカウント', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      { id: 'r-1', reporterId: 'u-1' },
    ] as never);
    vi.mocked(prisma.riskIssue.updateMany).mockResolvedValue({ count: 1 } as never);

    const r = await bulkUpdateRisksFromList('p-1', ['r-1', 'r-MISSING'], { state: 'in_progress' }, 'u-1');
    expect(r.updatedIds).toEqual(['r-1']);
    expect(r.skippedNotFound).toBe(1);
  });

  it('全件が他人作成なら updateMany を呼ばない', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      { id: 'r-1', reporterId: 'u-OTHER' },
    ] as never);
    const r = await bulkUpdateRisksFromList('p-1', ['r-1'], { state: 'resolved' }, 'u-1');
    expect(r.updatedIds).toEqual([]);
    expect(r.skippedNotOwned).toBe(1);
    expect(prisma.riskIssue.updateMany).not.toHaveBeenCalled();
  });

  it('patch.assigneeId=null は data に { assigneeId: null } として渡る (担当者クリア)', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      { id: 'r-1', reporterId: 'u-1' },
    ] as never);
    vi.mocked(prisma.riskIssue.updateMany).mockResolvedValue({ count: 1 } as never);

    await bulkUpdateRisksFromList('p-1', ['r-1'], { assigneeId: null }, 'u-1');
    const data = vi.mocked(prisma.riskIssue.updateMany).mock.calls[0][0].data;
    expect(data).toEqual({ updatedBy: 'u-1', assigneeId: null });
  });

  it('patch.deadline=null は data に { deadline: null } として渡る (1970 epoch 化を回避)', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      { id: 'r-1', reporterId: 'u-1' },
    ] as never);
    vi.mocked(prisma.riskIssue.updateMany).mockResolvedValue({ count: 1 } as never);

    await bulkUpdateRisksFromList('p-1', ['r-1'], { deadline: null }, 'u-1');
    const data = vi.mocked(prisma.riskIssue.updateMany).mock.calls[0][0].data;
    expect(data.deadline).toBe(null);
  });

  it('patch.deadline=YYYY-MM-DD は Date オブジェクトに変換される', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      { id: 'r-1', reporterId: 'u-1' },
    ] as never);
    vi.mocked(prisma.riskIssue.updateMany).mockResolvedValue({ count: 1 } as never);

    await bulkUpdateRisksFromList('p-1', ['r-1'], { deadline: '2026-12-31' }, 'u-1');
    const data = vi.mocked(prisma.riskIssue.updateMany).mock.calls[0][0].data;
    expect(data.deadline).toBeInstanceOf(Date);
    expect((data.deadline as Date).toISOString()).toContain('2026-12-31');
  });
});
