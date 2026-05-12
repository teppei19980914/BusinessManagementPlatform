import { describe, it, expect, vi, beforeEach } from 'vitest';

// 2026-05-12 severity-1 防御: PgTrgmSearchProvider.search の tenant フィルタを検証する
//   ため、Prisma を完全モック化して where 句を観測する。
vi.mock('@/lib/db', () => ({
  prisma: {
    knowledge: { findMany: vi.fn() },
  },
}));

import { createSearchProvider } from './index';
import { PgTrgmSearchProvider } from './pg-trgm-provider';
import { prisma } from '@/lib/db';

describe('createSearchProvider', () => {
  it('現在は PgTrgmSearchProvider を返す (環境変数分岐未実装)', () => {
    const provider = createSearchProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.search).toBe('function');
  });
});

// 2026-05-12 severity-1 防御: PgTrgmSearchProvider が tenantId フィルタを必ず転写することを検証
describe('PgTrgmSearchProvider — テナント分離 severity-1 防御 (2026-05-12)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('search.where に tenantId が必ず含まれる (越境遮断)', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    const provider = new PgTrgmSearchProvider();

    await provider.search({
      query: 'test',
      entityTypes: ['knowledge'],
      tenantId: 'tenant-A-id',
      limit: 10,
      offset: 0,
    });

    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0]![0];
    expect((call?.where as Record<string, unknown>)?.tenantId).toBe('tenant-A-id');
  });

  it('viewerUserId 省略時は visibility=public のみ', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    const provider = new PgTrgmSearchProvider();

    await provider.search({
      query: 'test',
      entityTypes: ['knowledge'],
      tenantId: 'tenant-A',
      limit: 10,
      offset: 0,
    });

    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0]![0];
    const where = call?.where as { AND?: Array<Record<string, unknown>> };
    // AND[0] は visibility 条件
    expect(where?.AND?.[0]).toEqual({ visibility: 'public' });
  });

  it('viewerUserId 指定時は public + 自分の draft', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    const provider = new PgTrgmSearchProvider();

    await provider.search({
      query: 'test',
      entityTypes: ['knowledge'],
      tenantId: 'tenant-A',
      viewerUserId: 'u-1',
      limit: 10,
      offset: 0,
    });

    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0]![0];
    const where = call?.where as { AND?: Array<Record<string, unknown>> };
    expect(where?.AND?.[0]).toEqual({
      OR: [
        { visibility: 'public' },
        { visibility: 'draft', createdBy: 'u-1' },
      ],
    });
  });

  it('viewerIsAdmin=true なら自テナント内の draft も全件閲覧可', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    const provider = new PgTrgmSearchProvider();

    await provider.search({
      query: 'test',
      entityTypes: ['knowledge'],
      tenantId: 'tenant-A',
      viewerIsAdmin: true,
      limit: 10,
      offset: 0,
    });

    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0]![0];
    const where = call?.where as { AND?: Array<Record<string, unknown>>; tenantId: string };
    // admin は visibility 制限なし (空オブジェクト)
    expect(where?.AND?.[0]).toEqual({});
    // ただし tenantId は必ず適用される
    expect(where.tenantId).toBe('tenant-A');
  });

  it('短すぎる query (< 2 文字) は DB を引かず空配列', async () => {
    const provider = new PgTrgmSearchProvider();
    const r = await provider.search({
      query: 'a',
      entityTypes: ['knowledge'],
      tenantId: 'tenant-A',
      limit: 10,
      offset: 0,
    });
    expect(r).toEqual([]);
    expect(prisma.knowledge.findMany).not.toHaveBeenCalled();
  });
});
