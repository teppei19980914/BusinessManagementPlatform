import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    riskIssue: { findFirst: vi.fn(), findMany: vi.fn() },
    knowledge: { findFirst: vi.fn(), findMany: vi.fn() },
    retrospective: { findFirst: vi.fn(), findMany: vi.fn() },
    memo: { findFirst: vi.fn(), findMany: vi.fn() },
    assetLink: {
      findFirst: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

import {
  isLinkableEntityType,
  getPubliclyVisibleFilter,
  isPublicEntity,
  createAssetLink,
  deleteAssetLink,
  getAssetLinks,
  searchLinkCandidates,
  deleteAssetLinksForEntity,
} from './asset-link.service';
import { prisma } from '@/lib/db';
import { getMockCallArg } from '@/lib/test-mock-helpers';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const now = new Date('2026-06-19T10:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isLinkableEntityType', () => {
  it('5 種 (risk/issue/knowledge/retrospective/memo) は true', () => {
    expect(isLinkableEntityType('risk')).toBe(true);
    expect(isLinkableEntityType('issue')).toBe(true);
    expect(isLinkableEntityType('knowledge')).toBe(true);
    expect(isLinkableEntityType('retrospective')).toBe(true);
    expect(isLinkableEntityType('memo')).toBe(true);
  });

  it('対象外 (task / customer 等) は false', () => {
    expect(isLinkableEntityType('task')).toBe(false);
    expect(isLinkableEntityType('customer')).toBe(false);
    expect(isLinkableEntityType('')).toBe(false);
  });
});

describe('getPubliclyVisibleFilter', () => {
  it('risk/issue は type discriminator を含む', () => {
    expect(getPubliclyVisibleFilter('risk')).toEqual({ deletedAt: null, type: 'risk', visibility: 'public' });
    expect(getPubliclyVisibleFilter('issue')).toEqual({ deletedAt: null, type: 'issue', visibility: 'public' });
  });

  it('knowledge/retrospective/memo は visibility のみ', () => {
    expect(getPubliclyVisibleFilter('knowledge')).toEqual({ deletedAt: null, visibility: 'public' });
    expect(getPubliclyVisibleFilter('retrospective')).toEqual({ deletedAt: null, visibility: 'public' });
    expect(getPubliclyVisibleFilter('memo')).toEqual({ deletedAt: null, visibility: 'public' });
  });
});

describe('isPublicEntity', () => {
  it('公開済みの risk は true', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ id: 'r-1', title: 'T', visibility: 'public' } as never);
    expect(await isPublicEntity('risk', 'r-1', TENANT_ID)).toBe(true);
  });

  it('存在しない/非公開の knowledge は false', async () => {
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue(null);
    expect(await isPublicEntity('knowledge', 'k-1', TENANT_ID)).toBe(false);
  });

  it('retrospective は conductedDate を YYYY-MM-DD で返す (title は null)', async () => {
    vi.mocked(prisma.retrospective.findFirst).mockResolvedValue({
      id: 'rt-1', conductedDate: new Date('2026-06-01T00:00:00Z'), visibility: 'public',
    } as never);
    expect(await isPublicEntity('retrospective', 'rt-1', TENANT_ID)).toBe(true);
  });
});

describe('createAssetLink', () => {
  it('同一エンティティへのリンクは SELF_LINK_FORBIDDEN', async () => {
    await expect(
      createAssetLink('risk', 'r-1', 'risk', 'r-1', 'u-1', TENANT_ID),
    ).rejects.toThrow('SELF_LINK_FORBIDDEN');
  });

  it('リンク元が非公開/存在しない場合は FROM_NOT_FOUND', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ id: 'k-1', title: 'K', visibility: 'public' } as never);
    await expect(
      createAssetLink('risk', 'r-1', 'knowledge', 'k-1', 'u-1', TENANT_ID),
    ).rejects.toThrow('FROM_NOT_FOUND');
  });

  it('リンク先が非公開/存在しない場合は TO_NOT_FOUND', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ id: 'r-1', type: 'risk', title: 'R', visibility: 'public' } as never);
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue(null);
    await expect(
      createAssetLink('risk', 'r-1', 'knowledge', 'k-1', 'u-1', TENANT_ID),
    ).rejects.toThrow('TO_NOT_FOUND');
  });

  it('既に逆方向 (B→A) のリンクが存在する場合は ALREADY_LINKED', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ id: 'r-1', title: 'R', visibility: 'public' } as never);
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ id: 'k-1', title: 'K', visibility: 'public' } as never);
    vi.mocked(prisma.assetLink.findFirst).mockResolvedValue({ id: 'link-1' } as never);

    await expect(
      createAssetLink('risk', 'r-1', 'knowledge', 'k-1', 'u-1', TENANT_ID),
    ).rejects.toThrow('ALREADY_LINKED');

    const call = getMockCallArg(vi.mocked(prisma.assetLink.findFirst));
    expect(call.where.OR).toEqual([
      { fromEntityType: 'risk', fromEntityId: 'r-1', toEntityType: 'knowledge', toEntityId: 'k-1' },
      { fromEntityType: 'knowledge', fromEntityId: 'k-1', toEntityType: 'risk', toEntityId: 'r-1' },
    ]);
  });

  it('成功時: リンクを作成し、toEntity を含む summary を返す', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ id: 'r-1', title: 'R', visibility: 'public' } as never);
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ id: 'k-1', title: 'K', visibility: 'public' } as never);
    vi.mocked(prisma.assetLink.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.assetLink.create).mockResolvedValue({
      id: 'link-1', createdAt: now, createdBy: 'u-1',
    } as never);

    const result = await createAssetLink('risk', 'r-1', 'knowledge', 'k-1', 'u-1', TENANT_ID);

    expect(prisma.assetLink.create).toHaveBeenCalledWith({
      data: { tenantId: TENANT_ID, fromEntityType: 'risk', fromEntityId: 'r-1', toEntityType: 'knowledge', toEntityId: 'k-1', createdBy: 'u-1' },
    });
    expect(result).toEqual({
      linkId: 'link-1',
      createdAt: now.toISOString(),
      createdBy: 'u-1',
      entity: { entityType: 'knowledge', entityId: 'k-1', title: 'K', conductedDate: null, visibility: 'public' },
    });
  });
});

describe('deleteAssetLink', () => {
  it('作成者本人 + 自テナントで削除できた場合は true', async () => {
    vi.mocked(prisma.assetLink.deleteMany).mockResolvedValue({ count: 1 } as never);
    expect(await deleteAssetLink('link-1', 'u-1', TENANT_ID)).toBe(true);
    expect(prisma.assetLink.deleteMany).toHaveBeenCalledWith({
      where: { id: 'link-1', tenantId: TENANT_ID, createdBy: 'u-1' },
    });
  });

  it('存在しない/他人/他テナントの場合は false (404/403 を区別しない)', async () => {
    vi.mocked(prisma.assetLink.deleteMany).mockResolvedValue({ count: 0 } as never);
    expect(await deleteAssetLink('link-1', 'u-other', TENANT_ID)).toBe(false);
  });
});

describe('getAssetLinks', () => {
  it('from/to どちらの向きでも相手側エンティティを解決して返す', async () => {
    vi.mocked(prisma.assetLink.findMany).mockResolvedValue([
      { id: 'link-1', fromEntityType: 'risk', fromEntityId: 'r-1', toEntityType: 'knowledge', toEntityId: 'k-1', createdAt: now, createdBy: 'u-1' },
      { id: 'link-2', fromEntityType: 'memo', fromEntityId: 'm-1', toEntityType: 'risk', toEntityId: 'r-1', createdAt: now, createdBy: 'u-2' },
    ] as never);
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ id: 'k-1', title: 'K', visibility: 'public' } as never);
    vi.mocked(prisma.memo.findFirst).mockResolvedValue({ id: 'm-1', title: 'M', visibility: 'public' } as never);

    const result = await getAssetLinks('risk', 'r-1', TENANT_ID);

    expect(result).toEqual([
      { linkId: 'link-1', createdAt: now.toISOString(), createdBy: 'u-1', entity: { entityType: 'knowledge', entityId: 'k-1', title: 'K', conductedDate: null, visibility: 'public' } },
      { linkId: 'link-2', createdAt: now.toISOString(), createdBy: 'u-2', entity: { entityType: 'memo', entityId: 'm-1', title: 'M', conductedDate: null, visibility: 'public' } },
    ]);
  });

  it('相手側が論理削除/非公開になった孤立リンクは結果から除外する', async () => {
    vi.mocked(prisma.assetLink.findMany).mockResolvedValue([
      { id: 'link-1', fromEntityType: 'risk', fromEntityId: 'r-1', toEntityType: 'knowledge', toEntityId: 'k-deleted', createdAt: now, createdBy: 'u-1' },
    ] as never);
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue(null);

    const result = await getAssetLinks('risk', 'r-1', TENANT_ID);

    expect(result).toEqual([]);
  });
});

describe('searchLinkCandidates', () => {
  it('risk/issue: title 部分一致 + excludeEntityId で自己除外', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([] as never);
    await searchLinkCandidates('issue', 'foo', TENANT_ID, 'i-self');
    const call = getMockCallArg(vi.mocked(prisma.riskIssue.findMany));
    expect(call.where).toMatchObject({
      tenantId: TENANT_ID,
      type: 'issue',
      visibility: 'public',
      id: { not: 'i-self' },
      title: { contains: 'foo', mode: 'insensitive' },
    });
  });

  it('retrospective: planSummary/actualSummary の OR 検索 (title 列がないため)', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([] as never);
    await searchLinkCandidates('retrospective', 'bar', TENANT_ID);
    const call = getMockCallArg(vi.mocked(prisma.retrospective.findMany));
    expect(call.where.OR).toEqual([
      { planSummary: { contains: 'bar', mode: 'insensitive' } },
      { actualSummary: { contains: 'bar', mode: 'insensitive' } },
    ]);
  });

  it('retrospective: 結果は title=null, conductedDate=YYYY-MM-DD で返す', async () => {
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      { id: 'rt-1', conductedDate: new Date('2026-06-01T00:00:00Z'), visibility: 'public' },
    ] as never);
    const result = await searchLinkCandidates('retrospective', '', TENANT_ID);
    expect(result).toEqual([{ entityType: 'retrospective', entityId: 'rt-1', title: null, conductedDate: '2026-06-01', visibility: 'public' }]);
  });

  it('memo: title 部分一致検索', async () => {
    vi.mocked(prisma.memo.findMany).mockResolvedValue([
      { id: 'm-1', title: 'メモA', visibility: 'public' },
    ] as never);
    const result = await searchLinkCandidates('memo', 'メモ', TENANT_ID);
    expect(result).toEqual([{ entityType: 'memo', entityId: 'm-1', title: 'メモA', conductedDate: null, visibility: 'public' }]);
  });

  it('knowledge: query 空文字の場合は title フィルタを付与しない', async () => {
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    await searchLinkCandidates('knowledge', '', TENANT_ID);
    const call = getMockCallArg(vi.mocked(prisma.knowledge.findMany));
    expect(call.where).not.toHaveProperty('title');
  });
});

describe('deleteAssetLinksForEntity', () => {
  it('from/to いずれかに一致するリンクを一括削除し、件数を返す', async () => {
    vi.mocked(prisma.assetLink.deleteMany).mockResolvedValue({ count: 2 } as never);
    const count = await deleteAssetLinksForEntity('memo', 'm-1', TENANT_ID);
    expect(count).toBe(2);
    expect(prisma.assetLink.deleteMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        OR: [
          { fromEntityType: 'memo', fromEntityId: 'm-1' },
          { toEntityType: 'memo', toEntityId: 'm-1' },
        ],
      },
    });
  });
});
