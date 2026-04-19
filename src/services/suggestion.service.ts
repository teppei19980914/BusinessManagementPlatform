/**
 * 提案型サービス (PR #65 核心機能)
 *
 * 本サービスはこのプロダクトの核心機能である
 * 「過去の資源を未来のプロジェクトに活用する」を実現するための推薦エンジン。
 *
 * 対象: 入力プロジェクト (新規 or 既存) に対して、過去の
 *   - Knowledge (全公開かつ自プロジェクト未紐付けのもの)
 *   - 過去の Issue (type='issue' かつ state='resolved', 他プロジェクトのもの)
 * を類似度スコア付きで返す。
 *
 * 類似度は以下の重み付き平均:
 *   - タグ交差 (Jaccard 係数): Project のタグ ↔ 対象のタグ
 *   - テキスト類似度 (pg_trgm similarity): Project の purpose+scope+background ↔
 *       対象の title+content
 *
 * 重み (Phase 1 の既定値):
 *   - タグ: 0.5
 *   - テキスト: 0.5
 *   将来 UI 側で再調整可能にする余地がある。
 */

import { prisma } from '@/lib/db';
import { jaccard, unifyProjectTags, unifyKnowledgeTags, combineScores } from '@/lib/similarity';

/**
 * 類似度スコア (0〜1 + 内訳) 付きの提案エントリ。
 * UI では `score` 降順で表示し、`tagScore` / `textScore` を tooltip 等で理由表示できる。
 */
export type SuggestionScore = {
  score: number;
  tagScore: number;
  textScore: number;
};

export type KnowledgeSuggestion = SuggestionScore & {
  kind: 'knowledge';
  id: string;
  title: string;
  knowledgeType: string;
  snippet: string;
  // 既に入力プロジェクトに紐付け済かどうか (UI で「追加」vs「紐付け済」を出し分け)
  alreadyLinked: boolean;
};

export type PastIssueSuggestion = SuggestionScore & {
  kind: 'issue';
  id: string;
  title: string;
  snippet: string;
  sourceProjectId: string;
  sourceProjectName: string | null;
};

export type SuggestionsResult = {
  knowledge: KnowledgeSuggestion[];
  pastIssues: PastIssueSuggestion[];
};

const TAG_WEIGHT = 0.5;
const TEXT_WEIGHT = 0.5;
/** 候補を最終的に残す閾値 (ノイズカット)。ユーザが見るリストに意味のない 0 付近を並べない */
const SCORE_THRESHOLD = 0.05;
/** 各カテゴリの最大件数。提案量が多すぎて読まれないのを防ぐ */
const DEFAULT_LIMIT = 10;

type ProjectContext = {
  id: string;
  tags: string[];
  text: string;
};

async function loadProjectContext(projectId: string): Promise<ProjectContext | null> {
  const p = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: {
      id: true,
      purpose: true,
      background: true,
      scope: true,
      businessDomainTags: true,
      techStackTags: true,
      processTags: true,
    },
  });
  if (!p) return null;
  const tags = unifyProjectTags({
    businessDomainTags: (p.businessDomainTags as string[]) ?? [],
    techStackTags: (p.techStackTags as string[]) ?? [],
    processTags: (p.processTags as string[]) ?? [],
  });
  const text = [p.purpose, p.background, p.scope].filter(Boolean).join(' ');
  return { id: p.id, tags, text };
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
  const limit = options.limit ?? DEFAULT_LIMIT;
  const ctx = await loadProjectContext(projectId);
  if (!ctx) return { knowledge: [], pastIssues: [] };

  // ---------- Knowledge 候補 ----------
  // visibility='public' のみ対象 (draft は作成者だけが閲覧できる想定)
  // 論理削除除外 + 既に紐付け済のナレッジは「alreadyLinked=true」で返すが除外はしない
  // (UI で "紐付け済" バッジを出せると便利なため)
  const knowledges = await prisma.knowledge.findMany({
    where: {
      deletedAt: null,
      visibility: 'public',
    },
    select: {
      id: true,
      title: true,
      knowledgeType: true,
      content: true,
      techTags: true,
      processTags: true,
      knowledgeProjects: { select: { projectId: true } },
    },
  });

  const kText = await computeTextSimilarities(
    ctx.text,
    knowledges.map((k) => ({ id: k.id, text: `${k.title} ${k.content}` })),
  );

  const knowledgeScored: KnowledgeSuggestion[] = knowledges.map((k) => {
    const kTags = unifyKnowledgeTags({
      techTags: (k.techTags as string[]) ?? [],
      processTags: (k.processTags as string[]) ?? [],
    });
    const tagScore = jaccard(ctx.tags, kTags);
    const textScore = kText.get(k.id) ?? 0;
    const score = combineScores([
      { score: tagScore, weight: TAG_WEIGHT },
      { score: textScore, weight: TEXT_WEIGHT },
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
      alreadyLinked: k.knowledgeProjects.some((kp) => kp.projectId === projectId),
    };
  });

  // ---------- 過去 Issue 候補 ----------
  // 他プロジェクトの解消済み issue を対象。
  // 同プロジェクトの未解消 issue は普段の「課題一覧」で見られるので除外。
  // リスクは不確実性で発生していないため対象外 (核心機能 UX 設計より)。
  const issues = await prisma.riskIssue.findMany({
    where: {
      deletedAt: null,
      type: 'issue',
      state: 'resolved',
      NOT: { projectId },
    },
    select: {
      id: true,
      title: true,
      content: true,
      projectId: true,
      project: { select: { name: true, deletedAt: true } },
    },
  });

  const iText = await computeTextSimilarities(
    ctx.text,
    issues.map((i) => ({ id: i.id, text: `${i.title} ${i.content}` })),
  );

  const issueScored: PastIssueSuggestion[] = issues.map((i) => {
    // Issue はタグ列を持たないため text スコアのみで判定する
    const tagScore = 0;
    const textScore = iText.get(i.id) ?? 0;
    const score = combineScores([
      { score: tagScore, weight: TAG_WEIGHT },
      { score: textScore, weight: TEXT_WEIGHT },
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
    };
  });

  // 閾値で足切り + スコア降順 + 件数上限
  const knowledge = knowledgeScored
    .filter((k) => k.score >= SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const pastIssues = issueScored
    .filter((i) => i.score >= SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { knowledge, pastIssues };
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
