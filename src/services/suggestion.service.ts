/**
 * 提案型サービス (PR #65 核心機能)
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
 * 類似度は以下の重み付き平均 (3 種共通):
 *   - タグ交差 (Jaccard 係数): Project のタグ ↔ 対象のタグ
 *     - Knowledge: Knowledge 自身の techTags+processTags+businessDomainTags
 *     - Issue / Retrospective: **親 Project のタグを proxy** として使用
 *       (Issue / Retro 自体は DB タグ列を持たないが、親 Project のドメインタグが
 *        意味的に妥当な近似となる。PR #140 後改修で Knowledge と同等の tag-aware に統一)
 *   - テキスト類似度 (pg_trgm similarity): Project の purpose+scope+background ↔
 *       対象の text (Knowledge: title+content, Issue: title+content,
 *       Retro: problems+improvements に限定)
 *
 * 重み (config/suggestion.ts):
 *   - タグ: SUGGESTION_TAG_WEIGHT
 *   - テキスト: SUGGESTION_TEXT_WEIGHT
 *   将来 UI 側で再調整可能にする余地がある。
 */

import { prisma } from '@/lib/db';
import { jaccard, unifyProjectTags, unifyKnowledgeTags, combineScores } from '@/lib/similarity';
import {
  SUGGESTION_TAG_WEIGHT as TAG_WEIGHT,
  SUGGESTION_TEXT_WEIGHT as TEXT_WEIGHT,
  SUGGESTION_SCORE_THRESHOLD as SCORE_THRESHOLD,
  SUGGESTION_DEFAULT_LIMIT as DEFAULT_LIMIT,
} from '@/config';

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

export type SuggestionsResult = {
  knowledge: KnowledgeSuggestion[];
  pastIssues: PastIssueSuggestion[];
  retrospectives: RetrospectiveSuggestion[];
};

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
  if (!ctx) return { knowledge: [], pastIssues: [], retrospectives: [] };

  // ---------- Knowledge 候補 ----------
  // visibility='public' のみ対象 (draft は作成者だけが閲覧できる想定)
  // 論理削除除外 + 入力プロジェクトに紐付け済のナレッジは候補から **除外**
  // (PR #160: 自プロジェクトで作成・紐付け済の内容を「参考」として提示しても価値がない)
  // 過去 Issue / Retrospective も同じく `NOT: { projectId }` で自プロジェクトを除外している。
  const knowledges = await prisma.knowledge.findMany({
    where: {
      deletedAt: null,
      visibility: 'public',
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

  const knowledgeScored: KnowledgeSuggestion[] = knowledges.map((k) => {
    const kTags = unifyKnowledgeTags({
      techTags: (k.techTags as string[]) ?? [],
      processTags: (k.processTags as string[]) ?? [],
      businessDomainTags: (k.businessDomainTags as string[]) ?? [],
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

  const issueScored: PastIssueSuggestion[] = issues.map((i) => {
    // 親 Project のタグを Issue 自身のタグとみなす (PR #140 後 改修)
    const issueProjectTags = unifyProjectTags({
      businessDomainTags: (i.project?.businessDomainTags as string[]) ?? [],
      techStackTags: (i.project?.techStackTags as string[]) ?? [],
      processTags: (i.project?.processTags as string[]) ?? [],
    });
    const tagScore = jaccard(ctx.tags, issueProjectTags);
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

  const retroScored: RetrospectiveSuggestion[] = retros.map((r) => {
    const retroProjectTags = unifyProjectTags({
      businessDomainTags: (r.project?.businessDomainTags as string[]) ?? [],
      techStackTags: (r.project?.techStackTags as string[]) ?? [],
      processTags: (r.project?.processTags as string[]) ?? [],
    });
    const tagScore = jaccard(ctx.tags, retroProjectTags);
    const textScore = rText.get(r.id) ?? 0;
    const score = combineScores([
      { score: tagScore, weight: TAG_WEIGHT },
      { score: textScore, weight: TEXT_WEIGHT },
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
  const retrospectives = retroScored
    .filter((r) => r.score >= SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { knowledge, pastIssues, retrospectives };
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
    };
  });

  return scored
    .filter((s) => s.score >= 0.08)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}
