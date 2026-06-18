import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    riskIssue: { findFirst: vi.fn() },
    riskIssuePromotion: { create: vi.fn(), findMany: vi.fn() },
    issueKnowledgePromotion: { create: vi.fn(), findMany: vi.fn() },
  },
}));

// promotion.service は既存の createRisk / createKnowledge を再利用する設計 (重複実装を避ける)。
// 本テストでは「正しい引数で呼び出されたか」のみ検証し、createRisk/createKnowledge 自体の
// ロジックは risk.service.test.ts / knowledge.service.test.ts でカバーする。
vi.mock('./risk.service', () => ({
  createRisk: vi.fn(),
}));
vi.mock('./knowledge.service', () => ({
  createKnowledge: vi.fn(),
}));

import {
  promoteRiskToIssue,
  promoteIssueToKnowledge,
  getPromotedIssues,
  getSourceRisks,
  getPromotedKnowledge,
  getSourceIssues,
} from './promotion.service';
import { prisma } from '@/lib/db';
import { createRisk } from './risk.service';
import { createKnowledge } from './knowledge.service';
import { getMockCallArg } from '@/lib/test-mock-helpers';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const now = new Date('2026-06-19T10:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('promoteRiskToIssue', () => {
  it('昇華元リスクが存在しない場合は NOT_FOUND', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(null);
    await expect(
      promoteRiskToIssue('r-1', 'p-1', { type: 'issue', title: 't' } as never, 'u-1', TENANT_ID),
    ).rejects.toThrow('NOT_FOUND');
  });

  it('昇華元が type=issue の場合は INVALID_SOURCE_TYPE', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ id: 'r-1', type: 'issue', visibility: 'public' } as never);
    await expect(
      promoteRiskToIssue('r-1', 'p-1', { type: 'issue', title: 't' } as never, 'u-1', TENANT_ID),
    ).rejects.toThrow('INVALID_SOURCE_TYPE');
  });

  it('昇華元が draft の場合は SOURCE_NOT_PUBLIC', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ id: 'r-1', type: 'risk', visibility: 'draft' } as never);
    await expect(
      promoteRiskToIssue('r-1', 'p-1', { type: 'issue', title: 't' } as never, 'u-1', TENANT_ID),
    ).rejects.toThrow('SOURCE_NOT_PUBLIC');
  });

  it('成功時: createRisk(type=issue 強制) → riskIssuePromotion.create → 新規 issue を返す', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ id: 'r-1', type: 'risk', visibility: 'public' } as never);
    const newIssue = { id: 'i-1', title: 't', visibility: 'public' };
    vi.mocked(createRisk).mockResolvedValue(newIssue as never);

    const result = await promoteRiskToIssue('r-1', 'p-1', { type: 'risk', title: 't' } as never, 'u-1', TENANT_ID);

    expect(createRisk).toHaveBeenCalledWith('p-1', { type: 'issue', title: 't' }, 'u-1', TENANT_ID);
    expect(prisma.riskIssuePromotion.create).toHaveBeenCalledWith({
      data: { riskId: 'r-1', issueId: 'i-1', createdBy: 'u-1' },
    });
    expect(result).toEqual(newIssue);
  });

  it('findFirst は tenantId と deletedAt:null で絞り込む (テナント越境防止)', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(null);
    await expect(promoteRiskToIssue('r-1', 'p-1', {} as never, 'u-1', TENANT_ID)).rejects.toThrow();
    const call = getMockCallArg(vi.mocked(prisma.riskIssue.findFirst));
    expect(call.where).toEqual({ id: 'r-1', deletedAt: null, tenantId: TENANT_ID });
  });
});

describe('promoteIssueToKnowledge', () => {
  it('昇華元課題が存在しない場合は NOT_FOUND', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(null);
    await expect(
      promoteIssueToKnowledge('i-1', { title: 't' } as never, 'u-1', TENANT_ID),
    ).rejects.toThrow('NOT_FOUND');
  });

  it('昇華元が type=risk の場合は INVALID_SOURCE_TYPE', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ id: 'i-1', type: 'risk', visibility: 'public' } as never);
    await expect(
      promoteIssueToKnowledge('i-1', { title: 't' } as never, 'u-1', TENANT_ID),
    ).rejects.toThrow('INVALID_SOURCE_TYPE');
  });

  it('昇華元が draft の場合は SOURCE_NOT_PUBLIC', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ id: 'i-1', type: 'issue', visibility: 'draft' } as never);
    await expect(
      promoteIssueToKnowledge('i-1', { title: 't' } as never, 'u-1', TENANT_ID),
    ).rejects.toThrow('SOURCE_NOT_PUBLIC');
  });

  it('成功時: createKnowledge → issueKnowledgePromotion.create → 新規ナレッジを返す', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({ id: 'i-1', type: 'issue', visibility: 'public' } as never);
    const newKnowledge = { id: 'k-1', title: 't', visibility: 'draft' };
    vi.mocked(createKnowledge).mockResolvedValue(newKnowledge as never);

    const result = await promoteIssueToKnowledge('i-1', { title: 't' } as never, 'u-1', TENANT_ID);

    expect(createKnowledge).toHaveBeenCalledWith({ title: 't' }, 'u-1', TENANT_ID);
    expect(prisma.issueKnowledgePromotion.create).toHaveBeenCalledWith({
      data: { issueId: 'i-1', knowledgeId: 'k-1', createdBy: 'u-1' },
    });
    expect(result).toEqual(newKnowledge);
  });
});

describe('getPromotedIssues', () => {
  it('riskId から昇華された課題一覧を返す (他テナント/削除済みは service 層 where で除外)', async () => {
    vi.mocked(prisma.riskIssuePromotion.findMany).mockResolvedValue([
      { issue: { id: 'i-1', title: 'A', visibility: 'public' }, createdAt: now },
    ] as never);

    const result = await getPromotedIssues('r-1', TENANT_ID);

    expect(prisma.riskIssuePromotion.findMany).toHaveBeenCalledWith({
      where: { riskId: 'r-1', issue: { tenantId: TENANT_ID, deletedAt: null } },
      include: { issue: { select: { id: true, title: true, visibility: true } } },
      orderBy: { createdAt: 'desc' },
    });
    expect(result).toEqual([{ id: 'i-1', title: 'A', visibility: 'public', promotedAt: now.toISOString() }]);
  });
});

describe('getSourceRisks', () => {
  it('issueId の昇華元リスク一覧を返す', async () => {
    vi.mocked(prisma.riskIssuePromotion.findMany).mockResolvedValue([
      { risk: { id: 'r-1', title: 'B', visibility: 'public' }, createdAt: now },
    ] as never);

    const result = await getSourceRisks('i-1', TENANT_ID);

    expect(prisma.riskIssuePromotion.findMany).toHaveBeenCalledWith({
      where: { issueId: 'i-1', risk: { tenantId: TENANT_ID, deletedAt: null } },
      include: { risk: { select: { id: true, title: true, visibility: true } } },
      orderBy: { createdAt: 'desc' },
    });
    expect(result).toEqual([{ id: 'r-1', title: 'B', visibility: 'public', promotedAt: now.toISOString() }]);
  });
});

describe('getPromotedKnowledge', () => {
  it('issueId から昇華されたナレッジ一覧を返す', async () => {
    vi.mocked(prisma.issueKnowledgePromotion.findMany).mockResolvedValue([
      { knowledge: { id: 'k-1', title: 'C', visibility: 'draft' }, createdAt: now },
    ] as never);

    const result = await getPromotedKnowledge('i-1', TENANT_ID);

    expect(prisma.issueKnowledgePromotion.findMany).toHaveBeenCalledWith({
      where: { issueId: 'i-1', knowledge: { tenantId: TENANT_ID, deletedAt: null } },
      include: { knowledge: { select: { id: true, title: true, visibility: true } } },
      orderBy: { createdAt: 'desc' },
    });
    expect(result).toEqual([{ id: 'k-1', title: 'C', visibility: 'draft', promotedAt: now.toISOString() }]);
  });
});

describe('getSourceIssues', () => {
  it('knowledgeId の昇華元課題一覧を返す', async () => {
    vi.mocked(prisma.issueKnowledgePromotion.findMany).mockResolvedValue([
      { issue: { id: 'i-1', title: 'D', visibility: 'public' }, createdAt: now },
    ] as never);

    const result = await getSourceIssues('k-1', TENANT_ID);

    expect(prisma.issueKnowledgePromotion.findMany).toHaveBeenCalledWith({
      where: { knowledgeId: 'k-1', issue: { tenantId: TENANT_ID, deletedAt: null } },
      include: { issue: { select: { id: true, title: true, visibility: true } } },
      orderBy: { createdAt: 'desc' },
    });
    expect(result).toEqual([{ id: 'i-1', title: 'D', visibility: 'public', promotedAt: now.toISOString() }]);
  });
});
