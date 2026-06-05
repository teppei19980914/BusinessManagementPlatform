/**
 * sample-clone.service の単体テスト (feat/starter-data-import / 2026-06-05)
 *
 * 検証観点:
 *   - 複製元が空なら NO_SAMPLE_DATA
 *   - 容量超過 (Beginner block) なら STORAGE_BLOCKED で投入しない
 *   - 正常系: 管理テナント sample を実行者テナントへ複製。tenantId 隔離 +
 *     isSampleData=false + isSeedSample=true で作成、embedding を raw SQL でコピー、監査ログ記録
 *   - 削除: tenantId + isSeedSample=true でスコープ限定 (越境しない)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findMany: vi.fn() },
    knowledge: { findMany: vi.fn() },
    riskIssue: { findMany: vi.fn() },
    retrospective: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/tenant', () => ({
  MANAGEMENT_TENANT_ID: '00000000-0000-0000-0000-ffffffffffff',
}));

const mockPrecheck = vi.fn();
vi.mock('@/services/import-storage-precheck.service', () => ({
  AVG_BYTES_PER_IMPORTED_ROW: {
    knowledge: 7 * 1024,
    risksIssues: 6 * 1024,
    retrospective: 8 * 1024,
    memo: 5 * 1024,
    task: 1 * 1024,
  },
  precheckImportStorage: (args: unknown) => mockPrecheck(args),
}));

const mockRecordAuditLog = vi.fn();
vi.mock('@/services/audit.service', () => ({
  recordAuditLog: (args: unknown) => mockRecordAuditLog(args),
}));

import { importSampleData, deleteSampleData } from './sample-clone.service';
import { prisma } from '@/lib/db';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  mockPrecheck.mockResolvedValue({ isBlocker: false, message: '' });
});

describe('importSampleData', () => {
  it('複製元が空なら NO_SAMPLE_DATA', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([] as never);

    const r = await importSampleData({ tenantId: TENANT_ID, userId: USER_ID, plan: 'beginner' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('NO_SAMPLE_DATA');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('容量超過 (Beginner block) なら STORAGE_BLOCKED で投入しない', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      { id: 'p1', customerId: 'c1', customer: { name: 'C' } },
    ] as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([] as never);
    mockPrecheck.mockResolvedValue({ isBlocker: true, message: '無料枠超過' });

    const r = await importSampleData({ tenantId: TENANT_ID, userId: USER_ID, plan: 'beginner' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('STORAGE_BLOCKED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('正常系: tenantId 隔離 + isSampleData=false + isSeedSample=true で複製し監査ログ記録', async () => {
    vi.mocked(prisma.project.findMany).mockResolvedValue([
      {
        id: 'src-p1',
        customerId: 'src-c1',
        customer: { name: 'サンプル商事', department: null, contactPerson: null, contactEmail: null, notes: null },
        name: 'サンプルPJ',
        purpose: 'p', background: 'b', scope: 's', outOfScope: null,
        devMethod: 'agile', contractType: null,
        businessDomainTags: [], techStackTags: [], processTags: [],
        plannedStartDate: new Date(), plannedEndDate: new Date(),
        actualStartDate: null, actualEndDate: null, status: 'planning', notes: null,
      },
    ] as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([] as never);

    const createdCustomer = vi.fn().mockResolvedValue({ id: 'new-c1' });
    const createdProject = vi.fn().mockResolvedValue({ id: 'new-p1' });
    const execRaw = vi.fn().mockResolvedValue(1);
    const tx = {
      customer: { create: createdCustomer },
      project: { create: createdProject },
      knowledge: { create: vi.fn() },
      riskIssue: { create: vi.fn() },
      riskIssueProject: { create: vi.fn() },
      retrospective: { create: vi.fn() },
      retrospectiveProject: { create: vi.fn() },
      $executeRaw: execRaw,
    };
    vi.mocked(prisma.$transaction).mockImplementation(((cb: (t: typeof tx) => unknown) => cb(tx)) as never);

    const r = await importSampleData({ tenantId: TENANT_ID, userId: USER_ID, plan: 'expert' });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.customers).toBe(1);
      expect(r.summary.projects).toBe(1);
    }
    // tenantId 隔離 + マーカー
    expect(createdProject).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          isSampleData: false,
          isSeedSample: true,
          createdBy: USER_ID,
        }),
      }),
    );
    expect(createdCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tenantId: TENANT_ID, isSeedSample: true }) }),
    );
    // embedding を raw SQL で複製先テナントにコピー (越境書込み遮断のため tenantId を渡す)
    // tagged template ($executeRaw) 呼び出し: 第1引数は TemplateStringsArray、続いて値がパラメータ化される
    expect(execRaw).toHaveBeenCalledWith(expect.any(Array), 'src-p1', 'new-p1', TENANT_ID);
    // 監査ログ
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, action: 'CREATE', entityType: 'sample_data_import', entityId: TENANT_ID }),
    );
  });
});

describe('deleteSampleData', () => {
  it('tenantId + isSeedSample=true でスコープ限定して物理削除 (越境しない)', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      riskIssue: { findMany: vi.fn().mockResolvedValue([{ id: 'r1' }]), deleteMany },
      retrospective: { findMany: vi.fn().mockResolvedValue([{ id: 't1' }]), deleteMany },
      knowledge: { deleteMany },
      project: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }]), deleteMany },
      customer: { count: vi.fn().mockResolvedValue(1), deleteMany },
      riskIssueProject: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      retrospectiveProject: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      knowledgeProject: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    vi.mocked(prisma.$transaction).mockImplementation(((cb: (t: typeof tx) => unknown) => cb(tx)) as never);

    const r = await deleteSampleData({ tenantId: TENANT_ID, userId: USER_ID });

    expect(r.ok).toBe(true);
    // すべての deleteMany が tenantId + isSeedSample=true でスコープされている
    for (const call of deleteMany.mock.calls) {
      expect(call[0]).toEqual({ where: { tenantId: TENANT_ID, isSeedSample: true } });
    }
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, action: 'DELETE', entityType: 'sample_data_import' }),
    );
  });
});
