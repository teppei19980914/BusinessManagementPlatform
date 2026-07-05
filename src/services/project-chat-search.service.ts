/**
 * プロジェクト内チャット意味検索サービス (v1.5.0)
 *
 * たすきフクロウの「PJ内から探す」タブ専用。
 * 指定プロジェクト内の 6 資産 (Knowledge / RiskIssue / Retrospective /
 * IdeaQaThread / IdeaWhiteboardSession / IdeaVotingSession) を意味検索する。
 *
 * 設計判断:
 *   - 検索スコープはプロジェクト単一 (projectId + tenantId で絞る)。
 *     テナント越境防止のため、tenantId チェックは API 層で実施済みを前提とする。
 *   - アイデア系は status='closed' のみ対象 (アクティブ中は keyword search で代替)。
 *   - クエリ embedding 生成は 'chat-semantic-search' featureUnit を流用 (グローバル検索と同扱い)。
 *   - pg_trgm fallback は実装しない (degraded=true で空配列を返す)。
 *
 * 課金:
 *   - ADR-0019: 'chat-semantic-search' は全プラン無料 (fair-use-limit 月 10,000 calls 制限のみ)
 *
 * 関連:
 *   - API route: src/app/api/projects/[projectId]/chat/search/route.ts
 *   - グローバル検索: src/services/chat-search.service.ts
 *   - embedding 生成: src/services/embedding.service.ts
 */

import { prisma } from '@/lib/db';
import { generateEmbedding } from './embedding.service';
import {
  SUGGESTION_DEFAULT_LIMIT,
  SUGGESTION_SCORE_THRESHOLD,
  assignPercentileTiers,
  applyMinimumGuarantee,
  classifyTier,
  type SuggestionTier,
} from '@/config/suggestion';

// ================================================================
// 公開型
// ================================================================

export type ProjectChatSearchKind =
  | 'knowledge'
  | 'risk'
  | 'issue'
  | 'retrospective'
  | 'qa_thread'
  | 'whiteboard_session'
  | 'voting_session';

export interface ProjectChatSearchHit {
  kind: ProjectChatSearchKind;
  id: string;
  title: string;
  snippet: string;
  score: number;
  tier: SuggestionTier;
}

export interface ProjectChatSearchResult {
  query: string;
  degraded: boolean;
  degradeReason?: string;
  results: {
    knowledges: ProjectChatSearchHit[];
    risksIssues: ProjectChatSearchHit[];
    retrospectives: ProjectChatSearchHit[];
    qaThreads: ProjectChatSearchHit[];
    whiteboardSessions: ProjectChatSearchHit[];
    votingSessions: ProjectChatSearchHit[];
  };
  totalCount: number;
}

export interface ProjectChatSearchInput {
  query: string;
  projectId: string;
  tenantId: string;
  userId: string;
  limit?: number;
}

// ================================================================
// 内部: pgvector クエリ
// ================================================================

interface RawHit {
  id: string;
  score: number;
}

async function pgvectorSearchKnowledge(
  projectId: string,
  tenantId: string,
  vectorText: string,
  limit: number,
): Promise<RawHit[]> {
  return prisma.$queryRaw<RawHit[]>`
    SELECT id::text AS id,
           1 - (("content_embedding" <=> ${vectorText}::vector) / 2) AS score
    FROM "knowledges"
    WHERE "content_embedding" IS NOT NULL
      AND "tenant_id" = ${tenantId}::uuid
      AND "project_id" = ${projectId}::uuid
      AND "deleted_at" IS NULL
      AND "visibility" = 'public'
    ORDER BY "content_embedding" <=> ${vectorText}::vector
    LIMIT ${limit}
  `;
}

async function pgvectorSearchRisksIssues(
  projectId: string,
  tenantId: string,
  vectorText: string,
  limit: number,
): Promise<RawHit[]> {
  return prisma.$queryRaw<RawHit[]>`
    SELECT id::text AS id,
           1 - (("content_embedding" <=> ${vectorText}::vector) / 2) AS score
    FROM "risks_issues"
    WHERE "content_embedding" IS NOT NULL
      AND "tenant_id" = ${tenantId}::uuid
      AND "project_id" = ${projectId}::uuid
      AND "deleted_at" IS NULL
      AND "visibility" = 'public'
    ORDER BY "content_embedding" <=> ${vectorText}::vector
    LIMIT ${limit}
  `;
}

async function pgvectorSearchRetrospectives(
  projectId: string,
  tenantId: string,
  vectorText: string,
  limit: number,
): Promise<RawHit[]> {
  return prisma.$queryRaw<RawHit[]>`
    SELECT id::text AS id,
           1 - (("content_embedding" <=> ${vectorText}::vector) / 2) AS score
    FROM "retrospectives"
    WHERE "content_embedding" IS NOT NULL
      AND "tenant_id" = ${tenantId}::uuid
      AND "project_id" = ${projectId}::uuid
      AND "deleted_at" IS NULL
      AND "visibility" = 'public'
    ORDER BY "content_embedding" <=> ${vectorText}::vector
    LIMIT ${limit}
  `;
}

async function pgvectorSearchQaThreads(
  projectId: string,
  tenantId: string,
  vectorText: string,
  limit: number,
): Promise<RawHit[]> {
  return prisma.$queryRaw<RawHit[]>`
    SELECT id::text AS id,
           1 - (("content_embedding" <=> ${vectorText}::vector) / 2) AS score
    FROM "idea_qa_threads"
    WHERE "content_embedding" IS NOT NULL
      AND "tenant_id" = ${tenantId}::uuid
      AND "project_id" = ${projectId}::uuid
      AND "deleted_at" IS NULL
      AND "status" = 'closed'
    ORDER BY "content_embedding" <=> ${vectorText}::vector
    LIMIT ${limit}
  `;
}

async function pgvectorSearchWhiteboardSessions(
  projectId: string,
  tenantId: string,
  vectorText: string,
  limit: number,
): Promise<RawHit[]> {
  return prisma.$queryRaw<RawHit[]>`
    SELECT id::text AS id,
           1 - (("content_embedding" <=> ${vectorText}::vector) / 2) AS score
    FROM "idea_whiteboard_sessions"
    WHERE "content_embedding" IS NOT NULL
      AND "tenant_id" = ${tenantId}::uuid
      AND "project_id" = ${projectId}::uuid
      AND "deleted_at" IS NULL
      AND "status" = 'closed'
    ORDER BY "content_embedding" <=> ${vectorText}::vector
    LIMIT ${limit}
  `;
}

async function pgvectorSearchVotingSessions(
  projectId: string,
  tenantId: string,
  vectorText: string,
  limit: number,
): Promise<RawHit[]> {
  return prisma.$queryRaw<RawHit[]>`
    SELECT id::text AS id,
           1 - (("content_embedding" <=> ${vectorText}::vector) / 2) AS score
    FROM "idea_voting_sessions"
    WHERE "content_embedding" IS NOT NULL
      AND "tenant_id" = ${tenantId}::uuid
      AND "project_id" = ${projectId}::uuid
      AND "deleted_at" IS NULL
      AND "status" = 'closed'
    ORDER BY "content_embedding" <=> ${vectorText}::vector
    LIMIT ${limit}
  `;
}

// ================================================================
// 内部: 本体情報ロード
// ================================================================

async function loadKnowledges(
  hits: RawHit[],
  tenantId: string,
  projectId: string,
): Promise<ProjectChatSearchHit[]> {
  if (hits.length === 0) return [];
  const ids = hits.map((h) => h.id);
  const rows = await prisma.knowledge.findMany({
    where: { id: { in: ids }, tenantId, projectId, deletedAt: null, visibility: 'public' },
    select: { id: true, title: true, content: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return hits.flatMap((h) => {
    const row = byId.get(h.id);
    if (!row) return [];
    return [{ kind: 'knowledge' as const, id: row.id, title: row.title, snippet: row.content.slice(0, 120), score: h.score, tier: classifyTier(h.score) }];
  });
}

async function loadRisksIssues(
  hits: RawHit[],
  tenantId: string,
  projectId: string,
): Promise<ProjectChatSearchHit[]> {
  if (hits.length === 0) return [];
  const ids = hits.map((h) => h.id);
  const rows = await prisma.riskIssue.findMany({
    where: { id: { in: ids }, tenantId, projectId, deletedAt: null, visibility: 'public' },
    select: { id: true, type: true, title: true, content: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return hits.flatMap((h) => {
    const row = byId.get(h.id);
    if (!row) return [];
    return [{ kind: (row.type === 'risk' ? 'risk' : 'issue') as ProjectChatSearchKind, id: row.id, title: row.title, snippet: row.content.slice(0, 120), score: h.score, tier: classifyTier(h.score) }];
  });
}

async function loadRetrospectives(
  hits: RawHit[],
  tenantId: string,
  projectId: string,
): Promise<ProjectChatSearchHit[]> {
  if (hits.length === 0) return [];
  const ids = hits.map((h) => h.id);
  const rows = await prisma.retrospective.findMany({
    where: { id: { in: ids }, tenantId, projectId, deletedAt: null, visibility: 'public' },
    select: { id: true, conductedDate: true, problems: true, improvements: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return hits.flatMap((h) => {
    const row = byId.get(h.id);
    if (!row) return [];
    const date = row.conductedDate.toISOString().split('T')[0];
    return [{
      kind: 'retrospective' as const,
      id: row.id,
      title: `${date} 振り返り`,
      snippet: `【問題点】${row.problems.slice(0, 60)}... 【次回事項】${row.improvements.slice(0, 60)}...`,
      score: h.score,
      tier: classifyTier(h.score),
    }];
  });
}

async function loadQaThreads(
  hits: RawHit[],
  tenantId: string,
  projectId: string,
): Promise<ProjectChatSearchHit[]> {
  if (hits.length === 0) return [];
  const ids = hits.map((h) => h.id);
  const rows = await prisma.ideaQaThread.findMany({
    where: { id: { in: ids }, tenantId, projectId, deletedAt: null, status: 'closed' },
    select: { id: true, question: true, answerCount: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return hits.flatMap((h) => {
    const row = byId.get(h.id);
    if (!row) return [];
    return [{
      kind: 'qa_thread' as const,
      id: row.id,
      title: row.question.slice(0, 80),
      snippet: `回答 ${row.answerCount} 件`,
      score: h.score,
      tier: classifyTier(h.score),
    }];
  });
}

async function loadWhiteboardSessions(
  hits: RawHit[],
  tenantId: string,
  projectId: string,
): Promise<ProjectChatSearchHit[]> {
  if (hits.length === 0) return [];
  const ids = hits.map((h) => h.id);
  const rows = await prisma.ideaWhiteboardSession.findMany({
    where: { id: { in: ids }, tenantId, projectId, deletedAt: null, status: 'closed' },
    select: { id: true, title: true, description: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return hits.flatMap((h) => {
    const row = byId.get(h.id);
    if (!row) return [];
    return [{
      kind: 'whiteboard_session' as const,
      id: row.id,
      title: row.title,
      snippet: (row.description ?? '').slice(0, 120),
      score: h.score,
      tier: classifyTier(h.score),
    }];
  });
}

async function loadVotingSessions(
  hits: RawHit[],
  tenantId: string,
  projectId: string,
): Promise<ProjectChatSearchHit[]> {
  if (hits.length === 0) return [];
  const ids = hits.map((h) => h.id);
  const rows = await prisma.ideaVotingSession.findMany({
    where: { id: { in: ids }, tenantId, projectId, deletedAt: null, status: 'closed' },
    select: { id: true, title: true, description: true, kind: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return hits.flatMap((h) => {
    const row = byId.get(h.id);
    if (!row) return [];
    const kindLabel = row.kind === 'live' ? 'ライブ投票' : '事前投票';
    return [{
      kind: 'voting_session' as const,
      id: row.id,
      title: row.title,
      snippet: `${kindLabel} ${(row.description ?? '').slice(0, 80)}`,
      score: h.score,
      tier: classifyTier(h.score),
    }];
  });
}

// ================================================================
// 公開関数
// ================================================================

const EMPTY_RESULTS = {
  knowledges: [],
  risksIssues: [],
  retrospectives: [],
  qaThreads: [],
  whiteboardSessions: [],
  votingSessions: [],
};

/**
 * プロジェクトスコープの意味検索を実行する。
 *
 * 認可前提: 呼び出し側 (API ルート) で projectId 所属確認済み。
 */
export async function projectChatSearch(
  input: ProjectChatSearchInput,
): Promise<ProjectChatSearchResult> {
  const trimmed = input.query.trim();
  const limit = input.limit ?? SUGGESTION_DEFAULT_LIMIT;

  if (trimmed.length === 0) {
    return { query: input.query, degraded: false, results: EMPTY_RESULTS, totalCount: 0 };
  }

  const embeddingResult = await generateEmbedding({
    text: trimmed,
    featureUnit: 'chat-semantic-search',
    tenantId: input.tenantId,
    userId: input.userId,
    inputType: 'query',
  });

  if (!embeddingResult.ok) {
    return {
      query: input.query,
      degraded: true,
      degradeReason: embeddingResult.reason,
      results: EMPTY_RESULTS,
      totalCount: 0,
    };
  }

  const vectorText = `[${embeddingResult.embedding.join(',')}]`;
  const { projectId, tenantId } = input;

  const [knowledgeHits, riskIssueHits, retroHits, qaHits, whiteboardHits, votingHits] =
    await Promise.all([
      pgvectorSearchKnowledge(projectId, tenantId, vectorText, limit),
      pgvectorSearchRisksIssues(projectId, tenantId, vectorText, limit),
      pgvectorSearchRetrospectives(projectId, tenantId, vectorText, limit),
      pgvectorSearchQaThreads(projectId, tenantId, vectorText, limit),
      pgvectorSearchWhiteboardSessions(projectId, tenantId, vectorText, limit),
      pgvectorSearchVotingSessions(projectId, tenantId, vectorText, limit),
    ]);

  const [knowledges, risksIssues, retrospectives, qaThreads, whiteboardSessions, votingSessions] =
    await Promise.all([
      loadKnowledges(knowledgeHits, tenantId, projectId).then((a) => assignPercentileTiers(applyMinimumGuarantee(a, SUGGESTION_SCORE_THRESHOLD))),
      loadRisksIssues(riskIssueHits, tenantId, projectId).then((a) => assignPercentileTiers(applyMinimumGuarantee(a, SUGGESTION_SCORE_THRESHOLD))),
      loadRetrospectives(retroHits, tenantId, projectId).then((a) => assignPercentileTiers(applyMinimumGuarantee(a, SUGGESTION_SCORE_THRESHOLD))),
      loadQaThreads(qaHits, tenantId, projectId).then((a) => assignPercentileTiers(applyMinimumGuarantee(a, SUGGESTION_SCORE_THRESHOLD))),
      loadWhiteboardSessions(whiteboardHits, tenantId, projectId).then((a) => assignPercentileTiers(applyMinimumGuarantee(a, SUGGESTION_SCORE_THRESHOLD))),
      loadVotingSessions(votingHits, tenantId, projectId).then((a) => assignPercentileTiers(applyMinimumGuarantee(a, SUGGESTION_SCORE_THRESHOLD))),
    ]);

  return {
    query: input.query,
    degraded: false,
    results: { knowledges, risksIssues, retrospectives, qaThreads, whiteboardSessions, votingSessions },
    totalCount: knowledges.length + risksIssues.length + retrospectives.length + qaThreads.length + whiteboardSessions.length + votingSessions.length,
  };
}
