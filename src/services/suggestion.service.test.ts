import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: vi.fn() },
    // 2026-05-09 (PR G / #24): loadProjectContext で seedDataEnabled を取得するため
    tenant: { findUnique: vi.fn() },
    // 2026-05-10 Phase 2-7: linkKnowledgeToProject で knowledge.findFirst によるテナント検証
    knowledge: { findMany: vi.fn(), findFirst: vi.fn() },
    knowledgeProject: { createMany: vi.fn() },
    riskIssue: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    retrospective: { findMany: vi.fn() },
    // (2026-05-15) Memo を提案候補に追加
    memo: { findMany: vi.fn() },
    // ADR-0021 (2026-05-26) 添付ファイルを提案候補に追加
    attachment: { findMany: vi.fn() },
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
  beforeEach(() => {
    vi.clearAllMocks();
    // 2026-05-09 (PR G / #24): デフォルトで seedDataEnabled=true (= 既存テスト互換)
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ seedDataEnabled: true } as never);
    // (2026-05-15) Memo の既定モック (空配列) — 個別テストで上書き可
    vi.mocked(prisma.memo.findMany).mockResolvedValue([] as never);
    // ADR-0021 (2026-05-26) Attachment の既定モック (空配列)
    vi.mocked(prisma.attachment.findMany).mockResolvedValue([] as never);
  });

  it('プロジェクト不在なら空結果', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null);

    const r = await suggestForProject('missing', 'tenant-A');
    expect(r).toEqual({ knowledge: [], pastIssues: [], pastRisks: [], retrospectives: [], memos: [], attachments: [] });
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

    const r = await suggestForProject('p-1', 'tenant-A');

    expect(r.knowledge[0].id).toBe('k-1');
    expect(r.pastIssues[0].id).toBe('i-1');
    expect(r.pastIssues[0].sourceProjectName).toBe('Other PJ');
    expect(r.retrospectives[0].id).toBe('r-1');
    expect(r.retrospectives[0].snippet).toContain('問題点');
  });

  // 2026-05-09 (PR G / #24): seedDataEnabled=false なら管理テナントを除外する
  // 2026-05-10 Phase 2-7: テナント越境遮断のため、seedDataEnabled=false は **自テナントのみ** に絞る
  //   (旧仕様の `{ not: MANAGEMENT_TENANT_ID }` は他顧客テナントの提案候補が混入する severity-1 バグ)。
  it('seedDataEnabled=false なら自テナント (viewerTenantId) のみを where 節で許容する (#24 / Phase 2-7)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-1',
      tenantId: 'tenant-customer',
      purpose: 'p',
      background: 'b',
      scope: 's',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    // 自テナントの seedDataEnabled = false
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({ seedDataEnabled: false } as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([]);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);

    await suggestForProject('p-1', 'tenant-customer');

    // knowledge.findMany の where に tenantId === 'tenant-customer' が含まれること
    const knowledgeCall = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(knowledgeCall?.where?.tenantId).toBe('tenant-customer');
  });

  // 2026-05-09 (PR G / #24): seedDataEnabled=true ならテナント除外フィルタは付かない
  // 2026-05-10 Phase 2-7: 旧仕様 (where に tenantId フィルタなし = 全テナント混入) は severity-1 バグ。
  //   現仕様: 自テナント + 管理テナント (シード) のみ許容。
  it('seedDataEnabled=true (default) なら自テナント + 管理テナントのみ許容する (#24 / Phase 2-7)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-1',
      tenantId: 'tenant-customer',
      purpose: 'p',
      background: 'b',
      scope: 's',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce({ seedDataEnabled: true } as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([]);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);

    await suggestForProject('p-1', 'tenant-customer');

    const knowledgeCall = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(knowledgeCall?.where?.tenantId).toEqual({
      in: ['tenant-customer', '00000000-0000-0000-0000-ffffffffffff'],
    });
  });

  // 2026-05-24 (PR fix/chat-search-and-auto-open): tenant lookup が null を返す異常系で
  // fail-closed = 自テナントのみで動作。旧仕様の `?? true` は MANAGEMENT_TENANT_ID のシード
  // を漏洩させうるフェイルオープンだったため修正。
  it('tenant lookup が null のとき seedDataEnabled=false 扱いで自テナントのみに絞る (fail-closed)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-1',
      tenantId: 'tenant-customer',
      purpose: 'p',
      background: 'b',
      scope: 's',
      businessDomainTags: [],
      techStackTags: [],
      processTags: [],
    } as never);
    // tenant 自体が見つからない (削除中 race / DB 異常等)
    vi.mocked(prisma.tenant.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([]);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);

    await suggestForProject('p-1', 'tenant-customer');

    // 旧仕様なら `{ in: ['tenant-customer', MANAGEMENT_TENANT_ID] }` だが、
    // fail-closed では自テナントのみ
    const knowledgeCall = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(knowledgeCall?.where?.tenantId).toBe('tenant-customer');
  });

  // 2026-05-09 (PR D / #21): 過去リスクが提案結果に含まれる
  it('過去 Risk を提案結果に含める (#21)', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue({
      id: 'p-1',
      purpose: 'p',
      background: 'b',
      scope: 's',
      businessDomainTags: ['finance'],
      techStackTags: [],
      processTags: [],
    } as never);
    vi.mocked(prisma.knowledge.findMany).mockResolvedValue([]);
    // riskIssue.findMany は issue クエリと risk クエリの 2 回呼ばれる。
    //   1 回目 (issue): 空配列で返す
    //   2 回目 (risk): risk row 1 件を返す
    vi.mocked(prisma.riskIssue.findMany)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'risk-1',
          title: 'past risk',
          content: 'about finance',
          projectId: 'p-2',
          project: {
            name: 'Other PJ',
            deletedAt: null,
            businessDomainTags: ['finance'],
            techStackTags: [],
            processTags: [],
          },
        },
      ] as never);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { id: 'risk-1', score: 0.7 },
    ] as never);

    const r = await suggestForProject('p-1', 'tenant-A');

    expect(r.pastRisks).toHaveLength(1);
    expect(r.pastRisks[0].id).toBe('risk-1');
    expect(r.pastRisks[0].kind).toBe('risk');
    expect(r.pastRisks[0].sourceProjectName).toBe('Other PJ');

    // riskIssue.findMany が 2 回呼ばれた (issue + risk) ことを確認
    expect(prisma.riskIssue.findMany).toHaveBeenCalledTimes(2);
    const riskCall = vi.mocked(prisma.riskIssue.findMany).mock.calls[1];
    if (!riskCall) throw new Error('Risk findMany call missing');
    // 2 回目の where に type='risk' AND state='resolved' が指定されていること
    expect((riskCall[0] as { where: { type: string; state: string } }).where.type).toBe('risk');
    expect((riskCall[0] as { where: { type: string; state: string } }).where.state).toBe('resolved');
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

    const r = await suggestForProject('p-1', 'tenant-A');
    expect(r.pastIssues[0].sourceProjectName).toBe(null);
  });

  it('PR-X6: score が閾値未満でも候補が最低件数未満なら最低件数保証で表示される (0 件回避)', async () => {
    // PR-X6 (2026-05-07) ユーザ要望対応:
    //   候補総数が SUGGESTION_MINIMUM_GUARANTEED_COUNT (=5) 未満かつ
    //   閾値以上が 1 件もない場合、それでも候補が「全件分」返る (0 件にならない構造保証)。
    //   候補総数が最低件数未満の場合は「全件返す」ため、ここでは 1 件返ることを期待。
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

    const r = await suggestForProject('p-1', 'tenant-A');
    // 候補総数 1 < 最低件数 5 なので全件 (1 件) 返る
    expect(r.knowledge).toHaveLength(1);
    // tier は weak (score < SUGGESTION_TIER_MEDIUM_THRESHOLD=0.1)
    expect(r.knowledge[0].tier).toBe('weak');
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

    const r = await suggestForProject('p-1', 'tenant-A');

    // tagScore は Issue / Retro 共に 0 でなく > 0 (親 Project タグの jaccard)
    // 旧実装は tagScore=0 固定だったので、>0 になること自体が parity 達成の証拠。
    // - Issue は project tags 完全一致 (3 タグ全部) → jaccard = 3/3 = 1.0
    // - Retro は project tags 部分一致 (1/3 タグ) → jaccard = 1/3 ≈ 0.333
    expect(r.pastIssues[0].tagScore).toBeCloseTo(1.0, 5);
    expect(r.retrospectives[0].tagScore).toBeCloseTo(1 / 3, 5);

    // 2026-05-14 確定仕様: project.content_embedding が NULL の場合、per-candidate で
    //   タグ:テキスト = 5:5 の縮退モード重み再配分が適用される。
    //   Issue: 0.5 * 1.0 + 0.5 * 0.5 + 0 * 0 = 0.75
    //   Retro: 0.5 * (1/3) + 0.5 * 0.5 + 0 * 0 ≈ 0.4167
    expect(r.pastIssues[0].score).toBeCloseTo(0.75, 5);
    expect(r.retrospectives[0].score).toBeCloseTo(1 / 3 / 2 + 0.5 / 2, 5);
    // tagScore=0 の旧実装は 0.5 * 0.5 = 0.25 まで届かなかった → tagScore が確かに寄与
    expect(r.pastIssues[0].score).toBeGreaterThan(0.25);
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

    const r = await suggestForProject('p-1', 'tenant-A');

    expect(r.knowledge).toHaveLength(1);
    const k = r.knowledge[0];
    expect(k.tagScore).toBe(0); // タグなし
    expect(k.textScore).toBeCloseTo(0.4, 5);
    expect(k.embeddingScore).toBeCloseTo(0.9, 5);
    // 3 軸合成: 0.3 * 0 + 0.2 * 0.4 + 0.5 * 0.9 = 0 + 0.08 + 0.45 = 0.53
    expect(k.score).toBeCloseTo(0.53, 5);
  });

  it('Project に embedding がない場合、縮退モードでタグ:テキスト=5:5 再配分される', async () => {
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

    const r = await suggestForProject('p-1', 'tenant-A');

    const k = r.knowledge[0];
    expect(k.embeddingScore).toBe(0);
    // 縮退モード (タグ:テキスト = 5:5): 0.5 * 0 + 0.5 * 0.5 + 0 * 0 = 0.25
    // (= ctx.embeddingText == null なので per-candidate 縮退が適用される)
    expect(k.score).toBeCloseTo(0.25, 5);
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

    const r = await suggestForProject('p-1', 'tenant-A');

    // score 降順で並ぶので k-with-emb が先頭
    expect(r.knowledge[0].id).toBe('k-with-emb');
    expect(r.knowledge[0].embeddingScore).toBeCloseTo(0.8, 5);
    expect(r.knowledge[1].id).toBe('k-no-emb');
    expect(r.knowledge[1].embeddingScore).toBe(0); // 除外されてスコア 0
    // k-with-emb (3 軸合成: 0.3*0 + 0.2*0.5 + 0.5*0.8 = 0.5)
    // k-no-emb (縮退 5:5 再配分: 0.5*0 + 0.5*0.5 + 0*0 = 0.25)
    expect(r.knowledge[0].score).toBeCloseTo(0.5, 5);
    expect(r.knowledge[1].score).toBeCloseTo(0.25, 5);
    expect(r.knowledge[0].score).toBeGreaterThan(r.knowledge[1].score);
  });

  // 2026-05-14: 確定仕様 (タグ:テキスト=5:5 縮退) で同じデータが embedding ありなしで
  // 概ね同等のスコアを得るかを確認する横断テスト。
  it('縮退モード適用後: 同じ tag/text スコアなら embedding あり/なしでスコア差は限定的', async () => {
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
      { id: 'k-with', title: 't', knowledgeType: 'l', content: 'c', techTags: [], processTags: [], businessDomainTags: [] },
      { id: 'k-no', title: 't', knowledgeType: 'l', content: 'c', techTags: [], processTags: [], businessDomainTags: [] },
    ] as never);
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([]);
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);

    // text 0.6 / 両候補同点、 embedding は片方のみ 0.6 (= 同程度の意味類似)
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([{ embedding: '[0.1,0.2]' }] as never)
      .mockResolvedValueOnce([
        { id: 'k-with', score: 0.6 },
        { id: 'k-no', score: 0.6 },
      ] as never)
      .mockResolvedValueOnce([{ id: 'k-with', score: 0.6 }] as never);

    const r = await suggestForProject('p-1', 'tenant-A');
    const withEmb = r.knowledge.find((x) => x.id === 'k-with')!;
    const noEmb = r.knowledge.find((x) => x.id === 'k-no')!;
    // 3 軸: 0.3*0 + 0.2*0.6 + 0.5*0.6 = 0.42
    expect(withEmb.score).toBeCloseTo(0.42, 5);
    // 縮退 5:5: 0.5*0 + 0.5*0.6 + 0*0 = 0.30
    expect(noEmb.score).toBeCloseTo(0.30, 5);
    // 旧仕様 (タグ 0.3 + テキスト 0.2 そのまま) なら 0.12 まで沈むところ、
    // 縮退モード再配分により 0.30 まで持ち上がっている (= 50% の引き上げ効果)
    expect(noEmb.score).toBeGreaterThan(0.12);
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

    const r = await suggestForProject('p-1', 'tenant-A');

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
      tenantId: 'tenant-customer',
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

    await suggestForProject('p-1', 'tenant-customer');

    // findMany の where 句に NOT: { knowledgeProjects: { some: { projectId: 'p-1' } } } が
    // 含まれているかを検証 (regression防止: alreadyLinked 戻し対策)
    // 2026-05-10 Phase 2-7: テナント越境遮断のため tenantId フィルタも併存する
    const call = vi.mocked(prisma.knowledge.findMany).mock.calls[0][0];
    expect(call?.where).toEqual({
      deletedAt: null,
      visibility: 'public',
      tenantId: { in: ['tenant-customer', '00000000-0000-0000-0000-ffffffffffff'] },
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

    const r = await suggestForProject('p-1', 'tenant-A');
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

    const r = await suggestForProject('p-1', 'tenant-A');
    expect(r.pastIssues[0].tagScore).toBe(0);
  });
});

describe('adoptPastIssueAsTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 2026-05-10 Phase 2-7: target project のテナント検証を全テストでパスさせる
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'target', tenantId: 'tenant-A' } as never);
  });

  it('元 issue がなければエラー', async () => {
    vi.mocked(prisma.riskIssue.findFirst).mockResolvedValue(null);
    await expect(
      adoptPastIssueAsTemplate('src', 'target', 'u-1', 'tenant-A'),
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

    const r = await adoptPastIssueAsTemplate('src', 'target', 'u-1', 'tenant-A');

    expect(r.id).toBe('new-id');
    const call = vi.mocked(prisma.riskIssue.create).mock.calls[0][0];
    expect(call.data.projectId).toBe('target');
    expect(call.data.state).toBe('open');
    expect(call.data.visibility).toBe('draft');
    expect(call.data.reporterId).toBe('u-1');
  });
});

describe('linkKnowledgeToProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 2026-05-10 Phase 2-7: knowledge / project のテナント検証 mock
    vi.mocked(prisma.knowledge.findFirst).mockResolvedValue({ id: 'k-1' } as never);
    vi.mocked(prisma.project.findFirst).mockResolvedValue({ id: 'p-1' } as never);
  });

  it('skipDuplicates で冪等に INSERT', async () => {
    vi.mocked(prisma.knowledgeProject.createMany).mockResolvedValue({ count: 1 } as never);

    await linkKnowledgeToProject('k-1', 'p-1', 'tenant-A');

    expect(prisma.knowledgeProject.createMany).toHaveBeenCalledWith({
      data: [{ knowledgeId: 'k-1', projectId: 'p-1' }],
      skipDuplicates: true,
    });
  });
});

describe('suggestRelatedIssuesForText', () => {
  beforeEach(() => vi.clearAllMocks());

  it('10 文字未満の入力は空配列 (ノイズ防止)', async () => {
    const r = await suggestRelatedIssuesForText('short', 'p-1', 'tenant-A');
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

    const r = await suggestRelatedIssuesForText('this is a long enough input', 'p-1', 'tenant-A');

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

    const r = await suggestForProject('any-project-id', 'tenant-A');

    expect(r).toEqual({ knowledge: [], pastIssues: [], pastRisks: [], retrospectives: [], memos: [], attachments: [] });
    // DB が一切呼ばれないことを確認 (LLM 呼び出しゼロの担保)
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
    expect(prisma.knowledge.findMany).not.toHaveBeenCalled();
    expect(prisma.riskIssue.findMany).not.toHaveBeenCalled();
    expect(prisma.memo.findMany).not.toHaveBeenCalled();
    expect(prisma.attachment.findMany).not.toHaveBeenCalled();

    delete process.env.SUGGESTION_ENGINE_DISABLED;
  });

  it('SUGGESTION_ENGINE_DISABLED=true で suggestRelatedIssuesForText も空配列を返す', async () => {
    process.env.SUGGESTION_ENGINE_DISABLED = 'true';

    const r = await suggestRelatedIssuesForText('long enough input text here', 'p-1', 'tenant-A');

    expect(r).toEqual([]);
    expect(prisma.riskIssue.findMany).not.toHaveBeenCalled();

    delete process.env.SUGGESTION_ENGINE_DISABLED;
  });

  it('SUGGESTION_ENGINE_DISABLED が未設定なら通常動作 (DB クエリが走る)', async () => {
    delete process.env.SUGGESTION_ENGINE_DISABLED;

    vi.mocked(prisma.project.findFirst).mockResolvedValue(null);
    await suggestForProject('p-1', 'tenant-A');

    expect(prisma.project.findFirst).toHaveBeenCalled();
  });

  it('SUGGESTION_ENGINE_DISABLED=false (明示) でも通常動作', async () => {
    process.env.SUGGESTION_ENGINE_DISABLED = 'false';

    vi.mocked(prisma.project.findFirst).mockResolvedValue(null);
    await suggestForProject('p-1', 'tenant-A');

    expect(prisma.project.findFirst).toHaveBeenCalled();

    delete process.env.SUGGESTION_ENGINE_DISABLED;
  });
});

// ================================================================
// PR #358 (2026-05-14): RiskIssue 候補に visibility='public' フィルタが必須
//   (PR #357 案D との整合性 — draft な resolved RiskIssue を候補から除外)
// ================================================================
describe('PR #358: RiskIssue findMany に visibility: public フィルタ必須', () => {
  beforeEach(() => vi.clearAllMocks());

  function setupProjectContext() {
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
    vi.mocked(prisma.retrospective.findMany).mockResolvedValue([]);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
  }

  it('suggestForProject の issue findMany where に visibility: public を含む', async () => {
    setupProjectContext();
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([] as never);

    await suggestForProject('p-1', 'tenant-A');

    // riskIssue.findMany は issue クエリ + risk クエリの 2 回呼ばれる
    expect(prisma.riskIssue.findMany).toHaveBeenCalledTimes(2);
    const issueCall = vi.mocked(prisma.riskIssue.findMany).mock.calls[0];
    if (!issueCall) throw new Error('issue findMany call missing');
    const where = (issueCall[0] as { where: { type: string; visibility: string } }).where;
    expect(where.type).toBe('issue');
    expect(where.visibility).toBe('public');
  });

  it('suggestForProject の risk findMany where に visibility: public を含む', async () => {
    setupProjectContext();
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([] as never);

    await suggestForProject('p-1', 'tenant-A');

    const riskCall = vi.mocked(prisma.riskIssue.findMany).mock.calls[1];
    if (!riskCall) throw new Error('risk findMany call missing');
    const where = (riskCall[0] as { where: { type: string; visibility: string } }).where;
    expect(where.type).toBe('risk');
    expect(where.visibility).toBe('public');
  });

  it('suggestRelatedIssuesForText の findMany where に visibility: public を含む', async () => {
    vi.mocked(prisma.riskIssue.findMany).mockResolvedValue([] as never);

    await suggestRelatedIssuesForText(
      'これは関連 issue を探すための 30 文字以上の問い合わせ本文です',
      'p-1',
      'tenant-A',
    );

    expect(prisma.riskIssue.findMany).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.riskIssue.findMany).mock.calls[0];
    if (!call) throw new Error('searchPastIssues findMany call missing');
    const where = (call[0] as { where: { type: string; state: string; visibility: string } }).where;
    expect(where.type).toBe('issue');
    expect(where.state).toBe('resolved');
    expect(where.visibility).toBe('public');
  });
});
