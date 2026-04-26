import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    stakeholder: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import {
  listStakeholders,
  getStakeholder,
  createStakeholder,
  updateStakeholder,
  deleteStakeholder,
} from './stakeholder.service';
import { prisma } from '@/lib/db';

const now = new Date('2026-04-27T10:00:00Z');

const sRow = (o: Record<string, unknown> = {}) => ({
  id: 's-1',
  projectId: 'p-1',
  userId: null,
  user: null,
  name: '山田太郎',
  organization: '顧客企画部',
  role: '部長',
  contactInfo: null,
  influence: 5,
  interest: 4,
  attitude: 'supportive',
  currentEngagement: 'neutral',
  desiredEngagement: 'supportive',
  personality: null,
  tags: ['数字派', '早朝型'],
  strategy: null,
  createdAt: now,
  updatedAt: now,
  ...o,
});

describe('listStakeholders', () => {
  beforeEach(() => vi.clearAllMocks());

  it('プロジェクト ID でフィルタし、deletedAt=null + 影響度 desc / 関心度 desc でソート', async () => {
    vi.mocked(prisma.stakeholder.findMany).mockResolvedValue([sRow()] as never);
    await listStakeholders('p-1');

    expect(prisma.stakeholder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'p-1', deletedAt: null },
        orderBy: [
          { influence: 'desc' },
          { interest: 'desc' },
          { createdAt: 'desc' },
        ],
      }),
    );
  });

  it('quadrant / engagementGap / linkedUserName を計算して DTO に含める', async () => {
    vi.mocked(prisma.stakeholder.findMany).mockResolvedValue([
      sRow({ influence: 5, interest: 5, currentEngagement: 'unaware', desiredEngagement: 'leading', userId: 'u-1', user: { name: '内部Aさん' } }),
      sRow({ id: 's-2', influence: 2, interest: 2, currentEngagement: 'supportive', desiredEngagement: 'supportive' }),
    ] as never);

    const result = await listStakeholders('p-1');

    expect(result[0].quadrant).toBe('manage_closely'); // 5x5 = high/high
    expect(result[0].engagementGap).toBe(4); // unaware (idx 0) → leading (idx 4)
    expect(result[0].linkedUserName).toBe('内部Aさん');

    expect(result[1].quadrant).toBe('monitor'); // 2x2 = low/low
    expect(result[1].engagementGap).toBe(0);
    expect(result[1].linkedUserName).toBe(null);
  });

  it('tags 列が配列以外でも空配列にフォールバック', async () => {
    vi.mocked(prisma.stakeholder.findMany).mockResolvedValue([
      sRow({ tags: null }),
      sRow({ id: 's-2', tags: 'broken-string' }),
    ] as never);

    const result = await listStakeholders('p-1');
    expect(result[0].tags).toEqual([]);
    expect(result[1].tags).toEqual([]);
  });
});

describe('getStakeholder', () => {
  beforeEach(() => vi.clearAllMocks());

  it('論理削除済 (deletedAt!=null) は除外して null を返す', async () => {
    vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue(null);
    const result = await getStakeholder('s-1');
    expect(result).toBeNull();

    const call = vi.mocked(prisma.stakeholder.findFirst).mock.calls[0]?.[0] as {
      where?: { id?: string; deletedAt?: unknown };
    } | undefined;
    expect(call?.where?.id).toBe('s-1');
    expect(call?.where?.deletedAt).toBeNull();
  });

  it('存在すれば DTO を返す', async () => {
    vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue(sRow() as never);
    const result = await getStakeholder('s-1');
    expect(result?.name).toBe('山田太郎');
    expect(result?.influence).toBe(5);
  });
});

describe('createStakeholder', () => {
  beforeEach(() => vi.clearAllMocks());

  it('createdBy / updatedBy に呼出ユーザを設定し、null フィールドを保持', async () => {
    vi.mocked(prisma.stakeholder.create).mockResolvedValue(sRow() as never);

    await createStakeholder(
      'p-1',
      {
        name: '山田太郎',
        influence: 5,
        interest: 4,
        attitude: 'supportive',
        currentEngagement: 'neutral',
        desiredEngagement: 'supportive',
        // organization 等を意図的に省略 (optional)
      },
      'u-creator',
    );

    const callArg = vi.mocked(prisma.stakeholder.create).mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(callArg.data.projectId).toBe('p-1');
    expect(callArg.data.createdBy).toBe('u-creator');
    expect(callArg.data.updatedBy).toBe('u-creator');
    expect(callArg.data.userId).toBeNull(); // 外部関係者
    expect(callArg.data.organization).toBeNull();
    expect(callArg.data.tags).toEqual([]);
  });
});

describe('updateStakeholder', () => {
  beforeEach(() => vi.clearAllMocks());

  it('既存が無ければ NOT_FOUND を投げる', async () => {
    vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue(null);
    await expect(updateStakeholder('s-1', { name: '新名' }, 'u-1')).rejects.toThrow('NOT_FOUND');
  });

  it('undefined フィールドは update payload に含めない (部分更新)', async () => {
    vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue({ id: 's-1' } as never);
    vi.mocked(prisma.stakeholder.update).mockResolvedValue(sRow({ name: '新名' }) as never);

    await updateStakeholder('s-1', { name: '新名' }, 'u-editor');

    const callArg = vi.mocked(prisma.stakeholder.update).mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(callArg.data.name).toBe('新名');
    expect(callArg.data.updatedBy).toBe('u-editor');
    // 渡していないフィールドは payload に含まれない
    expect(callArg.data).not.toHaveProperty('influence');
    expect(callArg.data).not.toHaveProperty('attitude');
  });

  it('null は明示クリアとして data に渡す (organization / contactInfo を消す操作)', async () => {
    vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue({ id: 's-1' } as never);
    vi.mocked(prisma.stakeholder.update).mockResolvedValue(sRow() as never);

    await updateStakeholder('s-1', { organization: null, contactInfo: null }, 'u-editor');

    const callArg = vi.mocked(prisma.stakeholder.update).mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(callArg.data.organization).toBeNull();
    expect(callArg.data.contactInfo).toBeNull();
  });
});

describe('deleteStakeholder', () => {
  beforeEach(() => vi.clearAllMocks());

  it('論理削除 (deletedAt セット + updatedBy 記録)', async () => {
    vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue({ id: 's-1' } as never);
    vi.mocked(prisma.stakeholder.update).mockResolvedValue(sRow() as never);

    await deleteStakeholder('s-1', 'u-deleter');

    const callArg = vi.mocked(prisma.stakeholder.update).mock.calls[0]?.[0] as {
      data: { deletedAt: Date; updatedBy: string };
    };
    expect(callArg.data.deletedAt).toBeInstanceOf(Date);
    expect(callArg.data.updatedBy).toBe('u-deleter');
  });

  it('既存が無ければ NOT_FOUND を投げる', async () => {
    vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue(null);
    await expect(deleteStakeholder('s-1', 'u-1')).rejects.toThrow('NOT_FOUND');
  });
});
