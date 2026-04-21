import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: vi.fn() },
    knowledge: { findMany: vi.fn() },
    knowledgeProject: { createMany: vi.fn() },
    riskIssue: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    retrospective: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

import {
  suggestForProject,
  adoptPastIssueAsTemplate,
  linkKnowledgeToProject,
  suggestRelatedIssuesForText,
} from './suggestion.service';
import { prisma } from '@/lib/db';

describe('suggestForProject', () => {
  beforeEach(() => vi.clearAllMocks());

  it('プロジェクト不在なら空結果', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null);

    const r = await suggestForProject('missing');
    expect(r).toEqual({ knowledge: [], pastIssues: [], retrospectives: [] });
  });

  it('ctx 取得後、knowledge / issue / retro の各候補を取得し DTO で返す', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-1',
      purpose: 'purpose text',
      background: 'bg',
      scope: 'scope',
      businessDomainTags: ['finance'],
      techStackTags: ['next'],
      processTags: ['agile'],
    } as never);

    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      {
        id: 'k-1',
        title: 'title',
        knowledgeType: 'lesson',
        content: 'content about finance',
        techTags: ['next'],
        processTags: ['agile'],
        businessDomainTags: ['finance'],
        knowledgeProjects: [{ projectId: 'p-1' }],
      },
    ] as never);

    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      {
        id: 'i-1',
        title: 'issue',
        content: 'about finance',
        projectId: 'p-2',
        project: { name: 'Other PJ', deletedAt: null },
      },
    ] as never);

    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      {
        id: 'r-1',
        conductedDate: new Date('2026-01-01'),
        problems: 'X',
        improvements: 'Y',
        projectId: 'p-2',
        project: { name: 'Other PJ', deletedAt: null },
      },
    ] as never);

    // $queryRaw (pg_trgm similarity) は十分高いスコアを返す想定
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { id: 'k-1', score: 0.8 },
      { id: 'i-1', score: 0.7 },
      { id: 'r-1', score: 0.6 },
    ] as never);

    const r = await suggestForProject('p-1');

    expect(r.knowledge[0].id).toBe('k-1');
    expect(r.knowledge[0].alreadyLinked).toBe(true);
    expect(r.pastIssues[0].id).toBe('i-1');
    expect(r.pastIssues[0].sourceProjectName).toBe('Other PJ');
    expect(r.retrospectives[0].id).toBe('r-1');
    expect(r.retrospectives[0].snippet).toContain('問題点');
  });

  it('削除済み project の sourceProjectName は null', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-1',
      purpose: 'x',
      background: '',
      scope: '',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      {
        id: 'i-1',
        title: 'issue',
        content: 'c',
        projectId: 'p-2',
        project: { name: 'Dead', deletedAt: new Date() },
      },
    ] as never);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { id: 'i-1', score: 0.9 },
    ] as never);

    const r = await suggestForProject('p-1');
    expect(r.pastIssues[0].sourceProjectName).toBe(null);
  });

  it('score が閾値未満なら除外される', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-1',
      purpose: 'x',
      background: '',
      scope: '',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      {
        id: 'k-1',
        title: '',
        knowledgeType: 'lesson',
        content: '',
        techTags: [],
        processTags: [],
        businessDomainTags: [],
        knowledgeProjects: [],
      },
    ] as never);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([]);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { id: 'k-1', score: 0.001 },
    ] as never);

    const r = await suggestForProject('p-1');
    expect(r.knowledge).toHaveLength(0);
  });
});

describe('adoptPastIssueAsTemplate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('元 issue がなければエラー', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(null);
    await expect(
      adoptPastIssueAsTemplate('src', 'target', 'u-1'),
    ).rejects.toThrow('source issue not found');
  });

  it('state=open / visibility=draft で複製する', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue({
      title: 't',
      content: 'c',
      cause: null,
      impact: 'high',
      likelihood: null,
      priority: 'high',
      responsePolicy: null,
      responseDetail: null,
    } as never);
    vi.mocked(prisma.riskIssue.create).mockResolvedValue({ id: 'new-id' } as never);

    const r = await adoptPastIssueAsTemplate('src', 'target', 'u-1');

    expect(r.id).toBe('new-id');
    const call = vi.mocked(prisma.riskIssue.create).mock.calls[0][0];
    expect(call.data.projectId).toBe('target');
    expect(call.data.state).toBe('open');
    expect(call.data.visibility).toBe('draft');
    expect(call.data.reporterId).toBe('u-1');
  });
});

describe('linkKnowledgeToProject', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skipDuplicates で冪等に INSERT', async () => {
    vi.mocked(prisma.knowledgeProject.createMany).mockResolvedValue({ count: 1 } as never);

    await linkKnowledgeToProject('k-1', 'p-1');

    expect(prisma.knowledgeProject.createMany).toHaveBeenCalledWith({
      data: [{ knowledgeId: 'k-1', projectId: 'p-1' }],
      skipDuplicates: true,
    });
  });
});

describe('suggestRelatedIssuesForText', () => {
  beforeEach(() => vi.clearAllMocks());

  it('10 文字未満の入力は空配列 (ノイズ防止)', async () => {
    const r = await suggestRelatedIssuesForText('short', 'p-1');
    expect(r).toEqual([]);
    expect(prisma.riskIssue.findMany).not.toHaveBeenCalled();
  });

  it('スコア降順 + 0.08 閾値 + 最大 5 件', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      { id: 'a', title: 'A', content: '', projectId: 'p-2', project: { name: 'p2', deletedAt: null } },
      { id: 'b', title: 'B', content: '', projectId: 'p-2', project: { name: 'p2', deletedAt: null } },
      { id: 'c', title: 'C', content: '', projectId: 'p-2', project: { name: 'p2', deletedAt: null } },
      { id: 'd', title: 'D', content: '', projectId: 'p-2', project: { name: 'p2', deletedAt: null } },
      { id: 'e', title: 'E', content: '', projectId: 'p-2', project: { name: 'p2', deletedAt: null } },
      { id: 'f', title: 'F', content: '', projectId: 'p-2', project: { name: 'p2', deletedAt: null } },
      { id: 'g', title: 'G', content: '', projectId: 'p-2', project: { name: 'p2', deletedAt: null } },
    ] as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.8 },
      { id: 'c', score: 0.7 },
      { id: 'd', score: 0.6 },
      { id: 'e', score: 0.5 },
      { id: 'f', score: 0.4 },
      { id: 'g', score: 0.05 }, // 閾値以下
    ] as never);

    const r = await suggestRelatedIssuesForText('this is a long enough input', 'p-1');

    expect(r).toHaveLength(5);
    expect(r[0].id).toBe('a');
    expect(r[4].id).toBe('e');
    expect(r.find((x) => x.id === 'g')).toBeUndefined();
  });
});
