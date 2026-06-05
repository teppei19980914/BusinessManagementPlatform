import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    estimate: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    // 2026-05-09 feedback Phase 2-6: createEstimate で project tenant 検証用
    project: { findFirst: vi.fn() },
    // 2026-06-02: 一覧の作成者/更新者名解決 (cross-tenant 氏名 lookup) 用
    user: { findMany: vi.fn().mockResolvedValue([]) },
    // PR #89: deleteEstimate が attachment.updateMany を $transaction 内で呼ぶ
    attachment: { updateMany: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

import {
  listEstimates,
  getEstimate,
  createEstimate,
  updateEstimate,
  confirmEstimate,
  deleteEstimate,
} from './estimate.service';
import { prisma } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';

const now = new Date('2026-04-21T10:00:00Z');
const dec = (n: number) => n as unknown as Prisma.Decimal;

const eRow = (o: Record<string, unknown> = {}) => ({
  id: 'e-1',
  projectId: 'p-1',
  itemName: '設計',
  category: 'design',
  devMethod: 'waterfall' as never,
  estimatedEffort: dec(10.5),
  effortUnit: 'person_day',
  rationale: '根拠',
  preconditions: null,
  isConfirmed: false,
  notes: null,
  createdBy: 'u-1',
  createdAt: now,
  updatedAt: now,
  ...o,
});

describe('listEstimates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('プロジェクトの有効な見積もりを並び順で返す', async () => {
    vi.mocked(prisma.estimate.findMany).mockResolvedValue([eRow()] as never);

    const r = await listEstimates('p-1', 'tenant-A');

    expect(r[0].estimatedEffort).toBe(10.5);
    expect(prisma.estimate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'p-1', deletedAt: null, project: { tenantId: 'tenant-A' } },
        orderBy: { createdAt: 'asc' },
      }),
    );
  });
});

describe('getEstimate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在しなければ null', async () => {
    vi.mocked(prisma.estimate.findFirst).mockResolvedValue(null);
    expect(await getEstimate('x', 'tenant-A')).toBe(null);
  });

  it('存在すれば DTO', async () => {
    vi.mocked(prisma.estimate.findFirst).mockResolvedValue(eRow() as never);
    const r = await getEstimate('e-1', 'tenant-A');
    expect(r?.id).toBe('e-1');
  });
});

describe('createEstimate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('必須値で作成し createdBy / updatedBy をセット', async () => {
    // 2026-05-09 feedback Phase 2-6: project tenant 検証用 mock
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'p-1' } as never);
    vi.mocked(prisma.estimate.create).mockResolvedValue(eRow() as never);

    await createEstimate(
      'p-1',
      {
        itemName: '設計',
        category: 'design',
        devMethod: 'waterfall' as never,
        estimatedEffort: 10.5,
        effortUnit: 'person_day',
        rationale: '根拠',
        preconditions: null,
        notes: null,
      },
      'u-1',
      'tenant-A',
    );

    expect(prisma.estimate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: 'p-1',
          createdBy: 'u-1',
          updatedBy: 'u-1',
        }),
      }),
    );
  });
});

describe('updateEstimate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('指定されたフィールドのみ data に積まれる', async () => {
    // 2026-05-09 feedback Phase 2-6: 所有確認 mock 必須
    vi.mocked(prisma.estimate.findFirst).mockResolvedValue({ id: 'e-1' } as never);
    vi.mocked(prisma.estimate.update).mockResolvedValue(eRow() as never);

    await updateEstimate('e-1', { itemName: 'new name' }, 'u-1', 'tenant-A');

    expect(prisma.estimate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'e-1' },
        data: { updatedBy: 'u-1', itemName: 'new name' },
      }),
    );
  });

  it('全フィールド更新を積める', async () => {
    vi.mocked(prisma.estimate.findFirst).mockResolvedValue({ id: 'e-1' } as never);
    vi.mocked(prisma.estimate.update).mockResolvedValue(eRow() as never);

    await updateEstimate(
      'e-1',
      {
        itemName: 'n',
        category: 'c' as never,
        devMethod: 'd' as never,
        estimatedEffort: 1,
        effortUnit: 'u' as never,
        rationale: 'r',
        preconditions: 'p',
        notes: 'n',
      },
      'u-1',
      'tenant-A',
    );

    const call = vi.mocked(prisma.estimate.update).mock.calls[0][0];
    expect(Object.keys(call.data)).toEqual(
      expect.arrayContaining([
        'updatedBy',
        'itemName',
        'category',
        'devMethod',
        'estimatedEffort',
        'effortUnit',
        'rationale',
        'preconditions',
        'notes',
      ]),
    );
  });
});

describe('confirmEstimate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('isConfirmed: true にする', async () => {
    vi.mocked(prisma.estimate.findFirst).mockResolvedValue({ id: 'e-1' } as never);
    vi.mocked(prisma.estimate.update).mockResolvedValue(
      eRow({ isConfirmed: true }) as never,
    );

    await confirmEstimate('e-1', 'u-1', 'tenant-A');

    expect(prisma.estimate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { isConfirmed: true, updatedBy: 'u-1' },
      }),
    );
  });
});

describe('deleteEstimate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletedAt をセット (論理削除)', async () => {
    vi.mocked(prisma.estimate.findFirst).mockResolvedValue({ id: 'e-1' } as never);
    vi.mocked(prisma.estimate.update).mockResolvedValue(eRow() as never);

    await deleteEstimate('e-1', 'u-1', 'tenant-A');

    expect(prisma.estimate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { deletedAt: expect.any(Date), updatedBy: 'u-1' },
      }),
    );
  });
});
