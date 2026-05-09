/**
 * 提案型サービス (PR #65 核心機能、PR #5-b で 3 軸合成に拡張)
 *
 * 本サービスはこのプロダクトの核心機能である
 * 「過去の資源を未来のプロジェクトに活用する」を実現するための推薦エンジン。
 *
 * 対象: 入力プロジェクト (新規 or 既存) に対して、以下を類似度スコア付きで返す:
 *   - Knowledge: 公開ナレッジのうち **入力プロジェクトに未紐付け** のもののみ
 *     (自プロジェクトで作成・紐付け済のナレッジは「参考」として提示する意味がないので除外。
 *      PR #160 で alreadyLinked フラグ運用から完全除外に切替)
 *   - 過去 Issue: type='issue' かつ state='resolved'、他プロジェクトのもの
 *   - 過去 Retrospective: visibility='public'、他プロジェクトのもの
 *
 * 類似度は **3 軸の重み付き平均** (PR #5-b / T-03 Phase 2):
 *   - タグ交差 (Jaccard 係数、重み 0.3): Project のタグ ↔ 対象のタグ
 *     - Knowledge: Knowledge 自身の techTags+processTags+businessDomainTags
 *     - Issue / Retrospective: **親 Project のタグを proxy** として使用
 *       (Issue / Retro 自体は DB タグ列を持たないが、親 Project のドメインタグが
 *        意味的に妥当な近似となる。PR #140 後改修で Knowledge と同等の tag-aware に統一)
 *   - テキスト類似度 (pg_trgm similarity、重み 0.2): Project の purpose+scope+background ↔
 *       対象の text (Knowledge: title+content, Issue: title+content,
 *       Retro: problems+improvements に限定)
 *   - **embedding 意味類似度** (Voyage AI voyage-4-lite Cosine Similarity、重み 0.5):
 *       PR #5-b で導入。タグ表記ゆれ・シノニムの問題を意味的に解決。
 *       embedding が NULL の候補は score=0 として計算される (→ 自動的に 2 軸縮退)。
 *
 * 重み (config/suggestion.ts):
 *   - SUGGESTION_TAG_WEIGHT       = 0.3
 *   - SUGGESTION_TEXT_WEIGHT      = 0.2
 *   - SUGGESTION_EMBEDDING_WEIGHT = 0.5
 *   合計 1.0。将来 UI 側で再調整可能にする余地がある。
 */

import { prisma } from '@/lib/db';
// 2026-05-09 (PR G / 設計合意 B + #24): シードデータは管理テナントに集中。
//   テナント別 seedDataEnabled toggle で管理テナントの参照を遮断する。
import { MANAGEMENT_TENANT_ID } from '@/lib/tenant';
import { jaccard, unifyProjectTags, unifyKnowledgeTags, combineScores } from '@/lib/similarity';
import {
  SUGGESTION_TAG_WEIGHT as TAG_WEIGHT,
  SUGGESTION_TEXT_WEIGHT as TEXT_WEIGHT,
  SUGGESTION_EMBEDDING_WEIGHT as EMBEDDING_WEIGHT,
  SUGGESTION_SCORE_THRESHOLD as SCORE_THRESHOLD,
  SUGGESTION_DEFAULT_LIMIT as DEFAULT_LIMIT,
} from '@/config';
import {
  isSuggestionEngineDisabled,
  classifyTier,
  applyMinimumGuarantee,
  assignPercentileTiers,
  type SuggestionTier,
} from '@/config/suggestion';

/**
 * 類似度スコア (0〜1 + 内訳) 付きの提案エントリ。
 * UI では `score` 降順で表示し、`tagScore` / `textScore` / `embeddingScore` を
 * tooltip 等で理由表示できる。embedding が未生成の候補は embeddingScore=0。
 *
 * PR-X6 (2026-05-07): `tier` フィールドを追加。UI の段階表示 (strong / medium / weak) で利用。
 */
export type SuggestionScore = {
  score: number;
  tagScore: number;
  textScore: number;
  /** PR #5-b (T-03 Phase 2): embedding 意味類似度。0=直交 / 1=完全一致。 */
  embeddingScore: number;
  /** PR-X6 (2026-05-07): スコアから自動分類された tier。UI の段階表示で利用。 */
  tier: SuggestionTier;
};

export type KnowledgeSuggestion = SuggestionScore & {
  kind: 'knowledge';
  id: string;
  title: string;
  knowledgeType: string;
  snippet: string;
};

export type PastIssueSuggestion = SuggestionScore & {
  kind: 'issue';
  id: string;
  title: string;
  snippet: string;
  sourceProjectId: string;
  sourceProjectName: string | null;
};

/**
 * PR #65 Phase 2 (a): 過去プロジェクトの振り返りを推薦対象に追加。
 * problems / improvements は次プロジェクトで避けたい失敗そのものなので、
 * 読み物として提示する価値が高い。採用 (雛形複製) は行わず参照のみ。
 */
export type RetrospectiveSuggestion = SuggestionScore & {
  kind: 'retrospective';
  id: string;
  conductedDate: string;
  snippet: string;
  sourceProjectId: string;
  sourceProjectName: string | null;
};

/**
 * 2026-05-09 (PR D / #21): 過去プロジェクトのリスクを推薦対象に追加。
 *   過去 Issue (発生した問題) との対比で、過去 Risk (発生に備えた対応事例) は
 *   「次プロジェクトで先回りで備える」ための雛形として参照価値が高い。
 *   旧仕様 (PR #65) は「リスクは不確実性で発生していないため対象外」としていたが、
 *   resolved 状態 = 顕在化したか / 対応済まで進んだもの は学びの宝庫。
 *   採用 (= 自プロジェクトへ複製) は行わず、参照のみ (Retrospective と同じ扱い)。
 */
export type PastRiskSuggestion = SuggestionScore & {
  kind: 'risk';
  id: string;
  title: string;
  snippet: string;
  sourceProjectId: string;
  sourceProjectName: string | null;
};

export type SuggestionsResult = {
  knowledge: KnowledgeSuggestion[];
  pastIssues: PastIssueSuggestion[];
  pastRisks: PastRiskSuggestion[];
  retrospectives: RetrospectiveSuggestion[];
};

type ProjectContext = {
  id: string;
  tags: string[];
  text: string;
  /**
   * PR #5-b (T-03 Phase 2): pgvector の `[1.234,...]` 文字列形式で取得した embedding。
   *   生成済なら content_embedding をそのまま使用、未生成 (NULL) なら null。
   *   null の場合は embedding 軸スコア = 0 で 2 軸縮退モード。
   */
  embeddingText: string | null;
  /**
   * PR G (#24 / 2026-05-09): 自テナントの seedDataEnabled。
   *   false のときは管理テナント (MANAGEMENT_TENANT_ID) のシードデータを提案候補から除外。
   */
  seedDataEnabled: boolean;
};

async function loadProjectContext(projectId: string): Promise<ProjectContext | null> {
  const p = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: {
      id: true,
      tenantId: true,
      purpose: true,
      background: true,
      scope: true,
      businessDomainTags: true,
      techStackTags: true,
      processTags: true,
    },
  });
  if (!p) return null;

  // PR G (#24): プロジェクトの所属テナントの seedDataEnabled を取得。
  //   この値で管理テナントのシードを提案候補に含めるかを判定する。
  const tenant = await prisma.tenant.findUnique({
    where: { id: p.tenantId },
    select: { seedDataEnabled: true },
  });
  const seedDataEnabled = tenant?.seedDataEnabled ?? true;
  const tags = unifyProjectTags({
    businessDomainTags: (p.businessDomainTags as string[]) ?? [],
    techStackTags: (p.techStackTags as string[]) ?? [],
    processTags: (p.processTags as string[]) ?? [],
  });
  const text = [p.purpose, p.background, p.scope].filter(Boolean).join(' ');

  // PR #5-b: content_embedding は Unsupported 型で findFirst の select に書けないため、
  // 別 query で取得 (NULL 許容、無ければ embedding スコア 0 で計算)。
  // ::text キャストで pgvector の `[1.234,...]` 形式を string として読み取る。
  const embRows = await prisma.$queryRaw<Array<{ embedding: string | null }>>`
    SELECT "content_embedding"::text AS embedding
    FROM "projects"
    WHERE id = ${projectId}::uuid
    LIMIT 1
  `;
  const embeddingText = embRows[0]?.embedding ?? null;

  return { id: p.id, tags, text, embeddingText, seedDataEnabled };
}

/**
 * PR #5-b (T-03 Phase 2): pgvector で候補 ids 群の embedding 類似度を 1 クエリで取得する。
 *
 * - クエリ embedding (queryEmbeddingText) と各候補の content_embedding の Cosine Similarity
 * - score = 1 - distance / 2 で 0.0〜1.0 に正規化 (1.0=完全一致)
 * - content_embedding が NULL の候補は結果に含まれない (= 呼び出し側で score=0 扱い)
 *
 * テーブル名は TypeScript union + exhaustive switch で SQL injection リスクを排除
 * (PR #224 と同じパターン)。
 */
type EmbeddingSimilarityTable = 'knowledges' | 'risks_issues' | 'retrospectives';

async function computeEmbeddingSimilarities(
  queryEmbeddingText: string | null,
  table: EmbeddingSimilarityTable,
  ids: string[],
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (queryEmbeddingText == null || ids.length === 0) return scores;

  let rows: Array<{ id: string; score: number }>;
  switch (table) {
    case 'knowledges':
      rows = await prisma.$queryRaw<Array<{ id: string; score: number }>>`
        SELECT id::text AS id,
               1 - (("content_embedding" <=> ${queryEmbeddingText}::vector) / 2) AS score
        FROM "knowledges"
        WHERE id = ANY(${ids}::uuid[])
          AND "content_embedding" IS NOT NULL
      `;
      break;
    case 'risks_issues':
      rows = await prisma.$queryRaw<Array<{ id: string; score: number }>>`
        SELECT id::text AS id,
               1 - (("content_embedding" <=> ${queryEmbeddingText}::vector) / 2) AS score
        FROM "risks_issues"
        WHERE id = ANY(${ids}::uuid[])
          AND "content_embedding" IS NOT NULL
      `;
      break;
    case 'retrospectives':
      rows = await prisma.$queryRaw<Array<{ id: string; score: number }>>`
        SELECT id::text AS id,
               1 - (("content_embedding" <=> ${queryEmbeddingText}::vector) / 2) AS score
        FROM "retrospectives"
        WHERE id = ANY(${ids}::uuid[])
          AND "content_embedding" IS NOT NULL
      `;
      break;
    default: {
      const _exhaustive: never = table;
      throw new Error(`Invalid table for embedding similarity: ${String(_exhaustive)}`);
    }
  }
  for (const r of rows) {
    scores.set(r.id, Number(r.score));
  }
  return scores;
}

/**
 * pg_trgm similarity() を使ってテキスト類似度を 1 クエリでまとめて取得する。
 * Prisma では similarity() を直接扱えないため $queryRaw を使う。
 * 引数はパラメータ化バインディング (Prisma.sql) で埋め込み、SQL インジェクションを防ぐ。
 */
async function computeTextSimilarities(
  queryText: string,
  targets: { id: string; text: string }[],
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (targets.length === 0 || queryText.trim().length === 0) return scores;

  // VALUES ($1, $2), ($3, $4), ... を動的に生成し、similarity(query, target_text) を row 単位で計算
  // 各 target.text は最長 2000 文字以内に丸める (類似度計算のコスト抑制)
  const rows = await prisma.$queryRaw<Array<{ id: string; score: number }>>`
    SELECT t.id, similarity(${queryText}, t.txt)::float AS score
    FROM (
      SELECT unnest(${targets.map((t) => t.id)}::text[]) AS id,
             unnest(${targets.map((t) => t.text.slice(0, 2000))}::text[]) AS txt
    ) t
  `;
  for (const r of rows) {
    scores.set(r.id, r.score);
  }
  return scores;
}

/**
 * 入力プロジェクトに対する提案リストを生成する。
 *
 * 認可前提: 呼び出し側 (API ルート) でプロジェクトメンバーシップを確認済み。
 * 本サービスはデータ整形のみを担当する (認可ロジックは持たない)。
 */
export async function suggestForProject(
  projectId: string,
  options: { limit?: number } = {},
): Promise<SuggestionsResult> {
  // PR #8 (T-03): 緊急停止フラグ。SUGGESTION_ENGINE_DISABLED=true で空配列を返す。
  // LLM 障害・予算超過・リグレッション切り分け時の即時停止に使う。
  if (isSuggestionEngineDisabled()) {
    return { knowledge: [], pastIssues: [], pastRisks: [], retrospectives: [] };
  }
  const limit = options.limit ?? DEFAULT_LIMIT;
  const ctx = await loadProjectContext(projectId);
  if (!ctx) return { knowledge: [], pastIssues: [], pastRisks: [], retrospectives: [] };

  // PR G (#24 / 2026-05-09): seedDataEnabled=false なら管理テナント (= シード保管先) を除外。
  //   true (default) の場合は条件を付与しない (= 全テナント横断、現状維持)。
  const excludeManagementTenant = !ctx.seedDataEnabled
    ? { tenantId: { not: MANAGEMENT_TENANT_ID } }
    : {};

  // ---------- Knowledge 候補 ----------
  // visibility='public' のみ対象 (draft は作成者だけが閲覧できる想定)
  // 論理削除除外 + 入力プロジェクトに紐付け済のナレッジは候補から **除外**
  // (PR #160: 自プロジェクトで作成・紐付け済の内容を「参考」として提示しても価値がない)
  // 過去 Issue / Retrospective も同じく `NOT: { projectId }` で自プロジェクトを除外している。
  const knowledges = await prisma.knowledge.findMany({
    where: {
      deletedAt: null,
      visibility: 'public',
      ...excludeManagementTenant,
      NOT: {
        knowledgeProjects: { some: { projectId } },
      },
    },
    select: {
      id: true,
      title: true,
      knowledgeType: true,
      content: true,
      techTags: true,
      processTags: true,
      businessDomainTags: true,
    },
  });

  const kText = await computeTextSimilarities(
    ctx.text,
    knowledges.map((k) => ({ id: k.id, text: `${k.title} ${k.content}` })),
  );
  // PR #5-b: embedding 軸スコア (Knowledge 候補)
  const kEmb = await computeEmbeddingSimilarities(
    ctx.embeddingText,
    'knowledges',
    knowledges.map((k) => k.id),
  );

  const knowledgeScored: KnowledgeSuggestion[] = knowledges.map((k) => {
    const kTags = unifyKnowledgeTags({
      techTags: (k.techTags as string[]) ?? [],
      processTags: (k.processTags as string[]) ?? [],
      businessDomainTags: (k.businessDomainTags as string[]) ?? [],
    });
    const tagScore = jaccard(ctx.tags, kTags);
    const textScore = kText.get(k.id) ?? 0;
    const embeddingScore = kEmb.get(k.id) ?? 0;
    const score = combineScores([
      { score: tagScore, weight: TAG_WEIGHT },
      { score: textScore, weight: TEXT_WEIGHT },
      { score: embeddingScore, weight: EMBEDDING_WEIGHT },
    ]);
    return {
      kind: 'knowledge' as const,
      id: k.id,
      title: k.title,
      knowledgeType: k.knowledgeType,
      snippet: k.content.slice(0, 120),
      score,
      tagScore,
      textScore,
      embeddingScore,
      tier: classifyTier(score),
    };
  });

  // ---------- 過去 Issue 候補 ----------
  // 他プロジェクトの解消済み issue を対象。
  // 同プロジェクトの未解消 issue は普段の「課題一覧」で見られるので除外。
  // リスクは不確実性で発生していないため対象外 (核心機能 UX 設計より)。
  //
  // タグスコア (PR #140 後 改修):
  //   Issue 自体は DB にタグ列を持たないが、**親 Project のタグを proxy** として
  //   利用することで Knowledge と同等の tag-aware なマッチングを実現する。
  //   semantic な妥当性: 「同じドメイン (e.g. fintech) のプロジェクトで起きた issue は
  //   別ドメインの issue より関連性が高い」。schema 変更不要。
  const issues = await prisma.riskIssue.findMany({
    where: {
      deletedAt: null,
      type: 'issue',
      state: 'resolved',
      ...excludeManagementTenant,
      NOT: { projectId },
    },
    select: {
      id: true,
      title: true,
      content: true,
      projectId: true,
      project: {
        select: {
          name: true,
          deletedAt: true,
          // tagScore 計算用: 親 Project のタグを proxy として使用
          businessDomainTags: true,
          techStackTags: true,
          processTags: true,
        },
      },
    },
  });

  const iText = await computeTextSimilarities(
    ctx.text,
    issues.map((i) => ({ id: i.id, text: `${i.title} ${i.content}` })),
  );
  // PR #5-b: embedding 軸スコア (RiskIssue 候補)
  const iEmb = await computeEmbeddingSimilarities(
    ctx.embeddingText,
    'risks_issues',
    issues.map((i) => i.id),
  );

  const issueScored: PastIssueSuggestion[] = issues.map((i) => {
    // 親 Project のタグを Issue 自身のタグとみなす (PR #140 後 改修)
    const issueProjectTags = unifyProjectTags({
      businessDomainTags: (i.project?.businessDomainTags as string[]) ?? [],
      techStackTags: (i.project?.techStackTags as string[]) ?? [],
      processTags: (i.project?.processTags as string[]) ?? [],
    });
    const tagScore = jaccard(ctx.tags, issueProjectTags);
    const textScore = iText.get(i.id) ?? 0;
    const embeddingScore = iEmb.get(i.id) ?? 0;
    const score = combineScores([
      { score: tagScore, weight: TAG_WEIGHT },
      { score: textScore, weight: TEXT_WEIGHT },
      { score: embeddingScore, weight: EMBEDDING_WEIGHT },
    ]);
    return {
      kind: 'issue' as const,
      id: i.id,
      title: i.title,
      snippet: i.content.slice(0, 120),
      sourceProjectId: i.projectId,
      sourceProjectName: i.project?.deletedAt ? null : i.project?.name ?? null,
      score,
      tagScore,
      textScore,
      embeddingScore,
      tier: classifyTier(score),
    };
  });

  // ---------- 過去 Risk 候補 (PR D / 2026-05-09 / #21) ----------
  // 他プロジェクトの解消済 risk を対象 (= 顕在化対応または計画通り収束)。
  // 自プロジェクトの未解消 risk は普段の「リスク一覧」で見られるので除外。
  // 旧仕様 (PR #65) で除外していたが、過去対応事例は次プロジェクトの先回り設計に役立つ
  // ため #21 で再導入。Issue と同じ tag-aware 設計 (親 Project のタグを proxy に使用)。
  const risks = await prisma.riskIssue.findMany({
    where: {
      deletedAt: null,
      type: 'risk',
      state: 'resolved',
      ...excludeManagementTenant,
      NOT: { projectId },
    },
    select: {
      id: true,
      title: true,
      content: true,
      projectId: true,
      project: {
        select: {
          name: true,
          deletedAt: true,
          businessDomainTags: true,
          techStackTags: true,
          processTags: true,
        },
      },
    },
  });

  const riskText = await computeTextSimilarities(
    ctx.text,
    risks.map((r) => ({ id: r.id, text: `${r.title} ${r.content}` })),
  );
  const riskEmb = await computeEmbeddingSimilarities(
    ctx.embeddingText,
    'risks_issues',
    risks.map((r) => r.id),
  );

  const riskScored: PastRiskSuggestion[] = risks.map((r) => {
    const riskProjectTags = unifyProjectTags({
      businessDomainTags: (r.project?.businessDomainTags as string[]) ?? [],
      techStackTags: (r.project?.techStackTags as string[]) ?? [],
      processTags: (r.project?.processTags as string[]) ?? [],
    });
    const tagScore = jaccard(ctx.tags, riskProjectTags);
    const textScore = riskText.get(r.id) ?? 0;
    const embeddingScore = riskEmb.get(r.id) ?? 0;
    const score = combineScores([
      { score: tagScore, weight: TAG_WEIGHT },
      { score: textScore, weight: TEXT_WEIGHT },
      { score: embeddingScore, weight: EMBEDDING_WEIGHT },
    ]);
    return {
      kind: 'risk' as const,
      id: r.id,
      title: r.title,
      snippet: r.content.slice(0, 120),
      sourceProjectId: r.projectId,
      sourceProjectName: r.project?.deletedAt ? null : r.project?.name ?? null,
      score,
      tagScore,
      textScore,
      embeddingScore,
      tier: classifyTier(score),
    };
  });

  // ---------- 過去 Retrospective 候補 (PR #65 Phase 2 (a)) ----------
  // 他プロジェクトの振り返り (confirmed) を対象。
  // 自プロジェクトの振り返りは普段の「振り返り一覧」で見られるので除外。
  // 比較対象は problems + improvements に絞る (「避けたい失敗」「次に活かす学び」が中心)。
  //
  // タグスコア (PR #140 後 改修):
  //   Retrospective 自体は DB にタグ列を持たないが、Issue と同じく **親 Project の
  //   タグを proxy** として使う。Knowledge と同等の tag-aware マッチングに統一。
  const retros = await prisma.retrospective.findMany({
    where: {
      deletedAt: null,
      visibility: 'public',
      ...excludeManagementTenant,
      NOT: { projectId },
    },
    select: {
      id: true,
      conductedDate: true,
      problems: true,
      improvements: true,
      projectId: true,
      project: {
        select: {
          name: true,
          deletedAt: true,
          // tagScore 計算用: 親 Project のタグを proxy として使用
          businessDomainTags: true,
          techStackTags: true,
          processTags: true,
        },
      },
    },
  });

  const rText = await computeTextSimilarities(
    ctx.text,
    retros.map((r) => ({ id: r.id, text: `${r.problems} ${r.improvements}` })),
  );
  // PR #5-b: embedding 軸スコア (Retrospective 候補)
  const rEmb = await computeEmbeddingSimilarities(
    ctx.embeddingText,
    'retrospectives',
    retros.map((r) => r.id),
  );

  const retroScored: RetrospectiveSuggestion[] = retros.map((r) => {
    const retroProjectTags = unifyProjectTags({
      businessDomainTags: (r.project?.businessDomainTags as string[]) ?? [],
      techStackTags: (r.project?.techStackTags as string[]) ?? [],
      processTags: (r.project?.processTags as string[]) ?? [],
    });
    const tagScore = jaccard(ctx.tags, retroProjectTags);
    const textScore = rText.get(r.id) ?? 0;
    const embeddingScore = rEmb.get(r.id) ?? 0;
    const score = combineScores([
      { score: tagScore, weight: TAG_WEIGHT },
      { score: textScore, weight: TEXT_WEIGHT },
      { score: embeddingScore, weight: EMBEDDING_WEIGHT },
    ]);
    return {
      kind: 'retrospective' as const,
      id: r.id,
      conductedDate: r.conductedDate.toISOString().split('T')[0],
      // 問題点 + 改善事項のスニペット (読み物として即座に価値が伝わる部分)
      snippet: `【問題点】${r.problems.slice(0, 80)}... 【次回事項】${r.improvements.slice(0, 80)}...`,
      sourceProjectId: r.projectId,
      sourceProjectName: r.project?.deletedAt ? null : r.project?.name ?? null,
      score,
      tagScore,
      textScore,
      embeddingScore,
      tier: classifyTier(score),
    };
  });

  // PR-X6 (2026-05-07) + P-1 (2026-05-08): スコア降順 + 件数保証 + 件数上限 + パーセンタイル tier。
  //   1. スコア降順で全候補をソート
  //   2. applyMinimumGuarantee で「閾値以上の候補が最低件数未満なら、全候補から Top N を返す」
  //      → サンプルと完全に異なる業務領域でも 0 件は構造的に発生しない
  //   3. 件数上限で切り詰め
  //   4. **assignPercentileTiers** でカテゴリごとに上位 30% / 50% / 20% の段階を再割り当て
  //      (P-1 / V1_FINAL_TASKS.md): 全候補が高スコア帯に集中して全件 strong になる事故を回避
  //
  //   各候補生成時 (map 内) で classifyTier(score) を一度付与しているのは、5 件以下の
  //   フォールバックや inline サジェストで再利用されるため (assignPercentileTiers 内で
  //   絶対閾値分類に切り替わる経路の整合性確保)。最終的な tier は assignPercentileTiers が
  //   上書きする。
  const sortByScore = <T extends { score: number }>(arr: T[]): T[] =>
    [...arr].sort((a, b) => b.score - a.score);

  const knowledge = assignPercentileTiers(
    applyMinimumGuarantee(sortByScore(knowledgeScored), SCORE_THRESHOLD).slice(0, limit),
  );
  const pastIssues = assignPercentileTiers(
    applyMinimumGuarantee(sortByScore(issueScored), SCORE_THRESHOLD).slice(0, limit),
  );
  // 2026-05-09 (PR D / #21): 過去 Risk も同じ tier 付与で返す
  const pastRisks = assignPercentileTiers(
    applyMinimumGuarantee(sortByScore(riskScored), SCORE_THRESHOLD).slice(0, limit),
  );
  const retrospectives = assignPercentileTiers(
    applyMinimumGuarantee(sortByScore(retroScored), SCORE_THRESHOLD).slice(0, limit),
  );

  return { knowledge, pastIssues, pastRisks, retrospectives };
}

/**
 * 過去 Issue を雛形として入力プロジェクトに新規 Issue を複製する。
 *
 * 「過去に発生した課題をテンプレとして新プロジェクトに事前登録し、
 *   未然に気付ける状態を作る」ための操作。
 * 複製元の state / result / lessonLearned は持ち越さず、
 * state='open' からリスタートする (新プロジェクトの実績はこれから作るため)。
 */
export async function adoptPastIssueAsTemplate(
  sourceIssueId: string,
  targetProjectId: string,
  userId: string,
): Promise<{ id: string }> {
  const src = await prisma.riskIssue.findFirst({
    where: { id: sourceIssueId, deletedAt: null, type: 'issue' },
    select: {
      title: true,
      content: true,
      cause: true,
      impact: true,
      likelihood: true,
      priority: true,
      responsePolicy: true,
      responseDetail: true,
    },
  });
  if (!src) throw new Error('source issue not found');

  const created = await prisma.riskIssue.create({
    data: {
      projectId: targetProjectId,
      type: 'issue',
      title: src.title,
      content: src.content,
      cause: src.cause,
      impact: src.impact,
      likelihood: src.likelihood,
      priority: src.priority,
      responsePolicy: src.responsePolicy,
      responseDetail: src.responseDetail,
      reporterId: userId,
      state: 'open',
      visibility: 'draft',
      createdBy: userId,
      updatedBy: userId,
    },
    select: { id: true },
  });

  return created;
}

/**
 * 既存 Knowledge を入力プロジェクトに紐付ける。
 * 中間テーブル KnowledgeProject に onConflict:do-nothing 相当の挙動で INSERT する。
 */
export async function linkKnowledgeToProject(
  knowledgeId: string,
  projectId: string,
): Promise<void> {
  // KnowledgeProject には @@unique([knowledgeId, projectId]) が張られているため、
  // skipDuplicates で冪等に INSERT する (連打や二重遷移で例外にならないように)
  await prisma.knowledgeProject.createMany({
    data: [{ knowledgeId, projectId }],
    skipDuplicates: true,
  });
}

/**
 * PR #65 Phase 2 (c): リスク起票ダイアログから呼ばれる、軽量の
 * 「今書いているテキストに類似する過去課題」検索。
 *
 * suggestForProject と似た処理だが、以下の点で最適化:
 *   - 呼び出し側が Project コンテキストを渡さなくていい (ユーザ入力 text を直接受け取る)
 *   - Knowledge や Retrospective は返さない (起票中は「他に発生例はあるか」のみ必要)
 *   - 件数上限を 5 件に絞る (起票中は画面占有を最小化したい)
 *   - 閾値を少し高く (0.08) して weak match を除く
 */
export async function suggestRelatedIssuesForText(
  inputText: string,
  currentProjectId: string,
): Promise<PastIssueSuggestion[]> {
  // PR #8 (T-03): 緊急停止フラグ。suggestForProject と同方針。
  if (isSuggestionEngineDisabled()) return [];
  const trimmed = inputText.trim();
  if (trimmed.length < 10) return []; // 10 文字未満はノイズ多いので走らせない

  const issues = await prisma.riskIssue.findMany({
    where: {
      deletedAt: null,
      type: 'issue',
      state: 'resolved',
      NOT: { projectId: currentProjectId },
    },
    select: {
      id: true,
      title: true,
      content: true,
      projectId: true,
      project: { select: { name: true, deletedAt: true } },
    },
  });

  const scores = await computeTextSimilarities(
    trimmed,
    issues.map((i) => ({ id: i.id, text: `${i.title} ${i.content}` })),
  );

  // PR #5-b (T-03 Phase 2): inline 軽量サジェストでは embedding 化を見送り。
  //   理由: 500ms debounce + 起票中の連続入力で 1 リクエスト毎に LLM 呼び出しを発生させると、
  //   レイテンシ・コスト両面で UX を圧迫する。pg_trgm の text 類似度で十分実用的。
  //   embedding 軸スコアは 0 で型互換のみ確保。
  const scored: PastIssueSuggestion[] = issues.map((i) => {
    const textScore = scores.get(i.id) ?? 0;
    return {
      kind: 'issue' as const,
      id: i.id,
      title: i.title,
      snippet: i.content.slice(0, 120),
      sourceProjectId: i.projectId,
      sourceProjectName: i.project?.deletedAt ? null : i.project?.name ?? null,
      score: textScore,
      tagScore: 0,
      textScore,
      embeddingScore: 0,
      tier: classifyTier(textScore),
    };
  });

  return scored
    .filter((s) => s.score >= 0.08)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}
