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
  // Phase D 要件 11/12 (2026-04-28): influence=5/interest=4 → manage_closely → 'high'
  priority: 'high',
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
      sRow({ influence: 5, interest: 5, priority: 'high', currentEngagement: 'unaware', desiredEngagement: 'leading', userId: 'u-1', user: { name: '内部Aさん' } }),
      sRow({ id: 's-2', influence: 2, interest: 2, priority: 'low', currentEngagement: 'supportive', desiredEngagement: 'supportive' }),
    ] as never);

    const result = await listStakeholders('p-1');

    expect(result[0].quadrant).toBe('manage_closely'); // 5x5 = high/high
    expect(result[0].engagementGap).toBe(4); // unaware (idx 0) → leading (idx 4)
    expect(result[0].linkedUserName).toBe('内部Aさん');

    expect(result[1].quadrant).toBe('monitor'); // 2x2 = low/low
    expect(result[1].engagementGap).toBe(0);
    expect(result[1].linkedUserName).toBe(null);
  });

  // Phase D 要件 12 (2026-04-28): listStakeholders は priority asc (high → medium → low) で
  // in-memory ソートする。Prisma の orderBy は influence/interest/createdAt のままだが、
  // DTO 化後に priority で並び替えて返す。
  it('priority asc (high → medium → low) で並び替えた DTO を返す', async () => {
    vi.mocked(prisma.stakeholder.findMany).mockResolvedValue([
      // findMany は influence desc 順なので high(5) → low(1) で返ってくる想定
      sRow({ id: 'A', influence: 1, interest: 5, priority: 'medium' }),
      sRow({ id: 'B', influence: 1, interest: 1, priority: 'low' }),
      sRow({ id: 'C', influence: 5, interest: 5, priority: 'high' }),
    ] as never);

    const result = await listStakeholders('p-1');
    // priority 順に並び替わっていることを id で検証
    expect(result.map((r) => r.id)).toEqual(['C', 'A', 'B']);
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

  // Phase D 要件 11 (2026-04-28): create 時に priority を influence × interest から自動分類して保存。
  it.each([
    [5, 5, 'high'],   // manage_closely
    [5, 3, 'medium'], // keep_satisfied
    [2, 5, 'medium'], // keep_informed
    [2, 2, 'low'],    // monitor
  ])('priority を influence=%d / interest=%d から %s に自動分類', async (influence, interest, expected) => {
    vi.mocked(prisma.stakeholder.create).mockResolvedValue(sRow({ priority: expected }) as never);

    await createStakeholder('p-1', {
      name: 't',
      influence,
      interest,
      attitude: 'neutral',
      currentEngagement: 'neutral',
      desiredEngagement: 'neutral',
    }, 'u-1');

    const callArg = vi.mocked(prisma.stakeholder.create).mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(callArg.data.priority).toBe(expected);
  });
});

describe('updateStakeholder', () => {
  beforeEach(() => vi.clearAllMocks());

  it('既存が無ければ NOT_FOUND を投げる', async () => {
    vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue(null);
    await expect(updateStakeholder('s-1', { name: '新名' }, 'u-1')).rejects.toThrow('NOT_FOUND');
  });

  it('undefined フィールドは update payload に含めない (部分更新)', async () => {
    vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue({ id: 's-1', influence: 5, interest: 4 } as never);
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
    // Phase D 要件 11: influence/interest 変更が無ければ priority も再計算しない
    expect(callArg.data).not.toHaveProperty('priority');
  });

  it('null は明示クリアとして data に渡す (organization / contactInfo を消す操作)', async () => {
    vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue({ id: 's-1', influence: 5, interest: 4 } as never);
    vi.mocked(prisma.stakeholder.update).mockResolvedValue(sRow() as never);

    await updateStakeholder('s-1', { organization: null, contactInfo: null }, 'u-editor');

    const callArg = vi.mocked(prisma.stakeholder.update).mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(callArg.data.organization).toBeNull();
    expect(callArg.data.contactInfo).toBeNull();
  });

  // Phase D 要件 11 (2026-04-28): influence または interest が変わったら priority を再計算。
  it('influence のみ変更でも priority を再計算 (existing.interest と組み合わせて derive)', async () => {
    vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue({ id: 's-1', influence: 5, interest: 5 } as never);
    vi.mocked(prisma.stakeholder.update).mockResolvedValue(sRow({ priority: 'medium' }) as never);

    // influence を 5 → 2 に下げると quadrant は manage_closely (high) → keep_informed (medium)
    await updateStakeholder('s-1', { influence: 2 }, 'u-editor');

    const callArg = vi.mocked(prisma.stakeholder.update).mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(callArg.data.influence).toBe(2);
    expect(callArg.data.priority).toBe('medium');
  });

  it('interest のみ変更でも priority を再計算', async () => {
    vi.mocked(prisma.stakeholder.findFirst).mockResolvedValue({ id: 's-1', influence: 2, interest: 2 } as never);
    vi.mocked(prisma.stakeholder.update).mockResolvedValue(sRow({ priority: 'medium' }) as never);

    // interest を 2 → 5 に上げると monitor (low) → keep_informed (medium)
    await updateStakeholder('s-1', { interest: 5 }, 'u-editor');

    const callArg = vi.mocked(prisma.stakeholder.update).mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(callArg.data.priority).toBe('medium');
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
