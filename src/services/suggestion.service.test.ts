import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

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

  // PR #140 後 改修: Issue / Retrospective が親 Project のタグを proxy として使うことの確認
  it('Issue / Retrospective は親 Project のタグで tagScore を計算する (Knowledge と同等の tag-aware)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-1',
      purpose: 'finance app',
      background: '',
      scope: '',
      // 入力 ctx のタグ
      businessDomainTags: ['fintech', 'banking'],
      techStackTags: ['react'],
      processTags: [],
    } as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);

    // Issue: 親 Project が同じドメインタグを持つ → tagScore > 0
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      {
        id: 'i-fintech',
        title: 'auth bug',
        content: 'about login',
        projectId: 'p-2',
        project: {
          name: 'Other Fintech',
          deletedAt: null,
          businessDomainTags: ['fintech', 'banking'],
          techStackTags: ['react'],
          processTags: [],
        },
      },
    ] as never);

    // Retro: 親 Project がドメインタグ部分一致 → tagScore > 0
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([
      {
        id: 'r-fintech',
        conductedDate: new Date('2026-01-01'),
        problems: 'X',
        improvements: 'Y',
        projectId: 'p-3',
        project: {
          name: 'Another Fintech',
          deletedAt: null,
          businessDomainTags: ['fintech'],
          techStackTags: [],
          processTags: [],
        },
      },
    ] as never);

    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { id: 'i-fintech', score: 0.5 },
      { id: 'r-fintech', score: 0.5 },
    ] as never);

    const r = await suggestForProject('p-1');

    // tagScore は Issue / Retro 共に 0 でなく > 0 (親 Project タグの jaccard)
    // 旧実装は tagScore=0 固定だったので、>0 になること自体が parity 達成の証拠。
    // - Issue は project tags 完全一致 (3 タグ全部) → jaccard = 3/3 = 1.0
    // - Retro は project tags 部分一致 (1/3 タグ) → jaccard = 1/3 ≈ 0.333
    expect(r.pastIssues[0].tagScore).toBeCloseTo(1.0, 5);
    expect(r.retrospectives[0].tagScore).toBeCloseTo(1 / 3, 5);

    // PR #5-b: 3 軸合成 (tag 0.3 / text 0.2 / embedding 0.5)。embedding は本テストで
    //   project.content_embedding が NULL のため 0、tagScore + textScore のみ寄与。
    //   Issue: 0.3 * 1.0 + 0.2 * 0.5 + 0.5 * 0 = 0.4
    //   Retro: 0.3 * (1/3) + 0.2 * 0.5 + 0.5 * 0 = 0.2
    expect(r.pastIssues[0].score).toBeCloseTo(0.4, 5);
    expect(r.retrospectives[0].score).toBeCloseTo(0.2, 5);
    // tagScore=0 の旧実装は 0.2 * 0.5 = 0.1 だった → tagScore が確かに寄与している
    expect(r.pastIssues[0].score).toBeGreaterThan(0.1);
  });

  // ========================================================
  // PR #5-b (T-03 Phase 2): embedding 軸スコアの統合テスト
  // ========================================================

  it('Project に embedding がある場合、embedding 軸スコアが 3 軸合成に寄与する', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-1',
      purpose: 'EC sites',
      background: '',
      scope: '',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      {
        id: 'k-1',
        title: 't',
        knowledgeType: 'lesson',
        content: 'c',
        techTags: [],
        processTags: [],
        businessDomainTags: [],
      },
    ] as never);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([]);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);

    // $queryRaw 呼び出しの順序:
    //   1. loadProjectContext: SELECT content_embedding → [{embedding: '[0.1,...]'}]
    //   2. computeTextSimilarities (knowledge): → [{id, score}]
    //   3. computeEmbeddingSimilarities (knowledges): → [{id, score}]
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([{ embedding: '[0.1,0.2]' }] as never)
      .mockResolvedValueOnce([{ id: 'k-1', score: 0.4 }] as never)
      .mockResolvedValueOnce([{ id: 'k-1', score: 0.9 }] as never);

    const r = await suggestForProject('p-1');

    expect(r.knowledge).toHaveLength(1);
    const k = r.knowledge[0];
    expect(k.tagScore).toBe(0); // タグなし
    expect(k.textScore).toBeCloseTo(0.4, 5);
    expect(k.embeddingScore).toBeCloseTo(0.9, 5);
    // 3 軸合成: 0.3 * 0 + 0.2 * 0.4 + 0.5 * 0.9 = 0 + 0.08 + 0.45 = 0.53
    expect(k.score).toBeCloseTo(0.53, 5);
  });

  it('Project に embedding がない場合、embedding 軸は 0 で 2 軸縮退モード', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-1',
      purpose: 'p',
      background: '',
      scope: '',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      {
        id: 'k-1',
        title: 't',
        knowledgeType: 'lesson',
        content: 'c',
        techTags: [],
        processTags: [],
        businessDomainTags: [],
      },
    ] as never);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([]);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);

    // 1. loadProjectContext: 空配列 (= embedding 未生成)
    // 2. computeTextSimilarities (knowledge): → [{id, score}]
    // (computeEmbeddingSimilarities は呼ばれない: embeddingText=null で early return)
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ id: 'k-1', score: 0.5 }] as never);

    const r = await suggestForProject('p-1');

    const k = r.knowledge[0];
    expect(k.embeddingScore).toBe(0);
    // 2 軸縮退: 0.3 * 0 + 0.2 * 0.5 + 0.5 * 0 = 0.1 (= score = textScore * TEXT_WEIGHT)
    expect(k.score).toBeCloseTo(0.1, 5);
  });

  it('候補側の embedding が NULL なら embeddingScore=0 (該当 id が結果セットに含まれない)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-1',
      purpose: 'p',
      background: '',
      scope: '',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      {
        id: 'k-with-emb',
        title: 'has emb',
        knowledgeType: 'lesson',
        content: 'c',
        techTags: [],
        processTags: [],
        businessDomainTags: [],
      },
      {
        id: 'k-no-emb',
        title: 'no emb',
        knowledgeType: 'lesson',
        content: 'c',
        techTags: [],
        processTags: [],
        businessDomainTags: [],
      },
    ] as never);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([]);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);

    // 1. project content_embedding あり
    // 2. text similarity: 両方 0.5
    // 3. embedding similarity: k-with-emb のみ (k-no-emb は WHERE content_embedding IS NOT NULL で除外)
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([{ embedding: '[0.1,0.2]' }] as never)
      .mockResolvedValueOnce([
        { id: 'k-with-emb', score: 0.5 },
        { id: 'k-no-emb', score: 0.5 },
      ] as never)
      .mockResolvedValueOnce([{ id: 'k-with-emb', score: 0.8 }] as never);

    const r = await suggestForProject('p-1');

    // score 降順で並ぶので k-with-emb が先頭
    expect(r.knowledge[0].id).toBe('k-with-emb');
    expect(r.knowledge[0].embeddingScore).toBeCloseTo(0.8, 5);
    expect(r.knowledge[1].id).toBe('k-no-emb');
    expect(r.knowledge[1].embeddingScore).toBe(0); // 除外されてスコア 0
    // k-with-emb の方が高スコア (embedding 寄与で差がつく)
    expect(r.knowledge[0].score).toBeGreaterThan(r.knowledge[1].score);
  });

  it('SuggestionScore 型に embeddingScore が含まれる', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-1',
      purpose: 'p',
      background: '',
      scope: '',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      {
        id: 'k-1',
        title: 't',
        knowledgeType: 'l',
        content: 'c',
        techTags: [],
        processTags: [],
        businessDomainTags: [],
      },
    ] as never);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([]);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ id: 'k-1', score: 1.0 }] as never);

    const r = await suggestForProject('p-1');

    // 型レベルでも runtime レベルでも embeddingScore フィールドが存在する
    expect(r.knowledge[0]).toHaveProperty('embeddingScore');
    expect(typeof r.knowledge[0].embeddingScore).toBe('number');
  });

  // PR #160 (fix/suggestion-exclude-self-project):
  // 自プロジェクトに紐付け済の Knowledge は提案候補から **完全除外** する。
  // 旧仕様 (alreadyLinked=true で印付け) では「参考」タブに自分が作ったナレッジが
  // 並ぶため UX 上ノイズになっていた。Issue / Retrospective が `NOT: { projectId }` で
  // 自プロジェクト除外しているのと parity を取った。
  it('自プロジェクトに紐付け済の Knowledge は where 節で除外する (PR #160)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-1',
      purpose: 'x',
      background: '',
      scope: '',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);

    await suggestForProject('p-1');

    // findMany の where 句に NOT: { knowledgeProjects: { some: { projectId: 'p-1' } } } が
    // 含まれているかを検証 (regression防止: alreadyLinked 戻し対策)
    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call?.where).toEqual({
      deletedAt: null,
      visibility: 'public',
      NOT: {
        knowledgeProjects: { some: { projectId: 'p-1' } },
      },
    });
  });

  // PR #160: KnowledgeSuggestion 型から alreadyLinked が削除されたことの確認
  // (UI 側の SuggestionsPanel もこのフィールドを参照しないようになった)
  it('KnowledgeSuggestion DTO に alreadyLinked フィールドは含まれない (PR #160)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-1',
      purpose: 'finance',
      background: '',
      scope: '',
      businessDomainTags: ['finance'],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([
      {
        id: 'k-1',
        title: 'title',
        knowledgeType: 'lesson',
        content: 'about finance',
        techTags: [],
        processTags: [],
        businessDomainTags: ['finance'],
      },
    ] as never);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { id: 'k-1', score: 0.5 },
    ] as never);

    const r = await suggestForProject('p-1');
    expect(r.knowledge[0]).not.toHaveProperty('alreadyLinked');
  });

  it('親 Project のタグが空なら Issue / Retrospective の tagScore は 0 (regression: 旧挙動と互換)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-1',
      purpose: 'x',
      background: '',
      scope: '',
      businessDomainTags: ['fintech'],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([
      {
        id: 'i-no-tags',
        title: 't',
        content: 'c',
        projectId: 'p-2',
        project: {
          name: 'Untagged',
          deletedAt: null,
          businessDomainTags: [],
          techStackTags: [],
          processTags: [],
        },
      },
    ] as never);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { id: 'i-no-tags', score: 0.5 },
    ] as never);

    const r = await suggestForProject('p-1');
    expect(r.pastIssues[0].tagScore).toBe(0);
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

// PR #8 (T-03 リリース準備): SUGGESTION_ENGINE_DISABLED 環境変数による緊急停止フラグ。
describe('suggestion engine 緊急停止フラグ (SUGGESTION_ENGINE_DISABLED)', () => {
  const originalEnv = process.env.SUGGESTION_ENGINE_DISABLED;

  beforeEach(() => vi.clearAllMocks());

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.SUGGESTION_ENGINE_DISABLED;
    else process.env.SUGGESTION_ENGINE_DISABLED = originalEnv;
  });

  it('SUGGESTION_ENGINE_DISABLED=true で suggestForProject は即座に空配列を返す (DB クエリ走らない)', async () => {
    process.env.SUGGESTION_ENGINE_DISABLED = 'true';

    const r = await suggestForProject('any-project-id');

    expect(r).toEqual({ knowledge: [], pastIssues: [], retrospectives: [] });
    // DB が一切呼ばれないことを確認 (LLM 呼び出しゼロの担保)
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
    expect(prisma.knowledge.findMany).not.toHaveBeenCalled();
    expect(prisma.riskIssue.findMany).not.toHaveBeenCalled();

    delete process.env.SUGGESTION_ENGINE_DISABLED;
  });

  it('SUGGESTION_ENGINE_DISABLED=true で suggestRelatedIssuesForText も空配列を返す', async () => {
    process.env.SUGGESTION_ENGINE_DISABLED = 'true';

    const r = await suggestRelatedIssuesForText('long enough input text here', 'p-1');

    expect(r).toEqual([]);
    expect(prisma.riskIssue.findMany).not.toHaveBeenCalled();

    delete process.env.SUGGESTION_ENGINE_DISABLED;
  });

  it('SUGGESTION_ENGINE_DISABLED が未設定なら通常動作 (DB クエリが走る)', async () => {
    delete process.env.SUGGESTION_ENGINE_DISABLED;

    vi.mocked(prisma.project.findFirst).mockResolvedValue(null);
    await suggestForProject('p-1');

    expect(prisma.project.findFirst).toHaveBeenCalled();
  });

  it('SUGGESTION_ENGINE_DISABLED=false (明示) でも通常動作', async () => {
    process.env.SUGGESTION_ENGINE_DISABLED = 'false';

    vi.mocked(prisma.project.findFirst).mockResolvedValue(null);
    await suggestForProject('p-1');

    expect(prisma.project.findFirst).toHaveBeenCalled();

    delete process.env.SUGGESTION_ENGINE_DISABLED;
  });
});
