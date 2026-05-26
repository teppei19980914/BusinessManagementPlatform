/**
 * チャット意味検索サービス (仕様: docs/specification/CHAT_SEMANTIC_SEARCH.md)
 *
 * ユーザの自然文クエリから、5 資産 (Project / Knowledge / RiskIssue /
 * Retrospective / Memo) を横断的に意味検索する。既存提案エンジンと同じ
 * Voyage embedding + pgvector 基盤を共有し、表示時にもクエリ側 embedding を
 * リアルタイム生成する (= 提案機能との根本的な違い)。
 *


 * 設計判断:
 *   - generateEmbedding ({ inputType: 'query' }) で 1 ApiCallLog 計上 (cost=0)
 *     ADR-0019 (2026-05-24): チャット検索は全プラン無料化。ApiCallLog には監査・分析目的で
 *     cost=0 で記録するが、Tenant counter / Stripe queue / Beginner 上限のいずれにも影響しない。
 *     暴走防止は fair-use-limit (月 10,000 calls/tenant) で対応する。
 *   - 5 資産は並列 (Promise.all) で pgvector Cosine 検索
 *   - 各資産で SUGGESTION_DEFAULT_LIMIT (= 50) 件取得、assignPercentileTiers
 *     で tier 分類、weak は UI 側で折りたたみ
 *   - テナント越境防止: viewerTenantId 必須、seedDataEnabled でシード可否
 *   - 縮退モード: embedding 失敗 (rate_limited / budget_exceeded 等) 時は
 *     pg_trgm fallback、検索結果は減るが機能停止しない
 *   - visibility フィルタ: Knowledge / RiskIssue / Retrospective は 'public' のみ、
 *     Memo は ('public' OR viewerUserId 自身) — 自分の private メモも検索対象
 *   - Project は visibility カラムなし、tenant 内 non-deleted 全件
 *
 * 関連:
 *   - 仕様: docs/specification/CHAT_SEMANTIC_SEARCH.md
 *   - 基盤: src/services/embedding.service.ts (generateEmbedding / Voyage)
 *   - 課金: src/lib/llm/metered.ts (withMeteredLLM)
 *   - スコア: src/config/suggestion.ts (assignPercentileTiers / applyMinimumGuarantee)
 */

import { prisma } from '@/lib/db';
import { generateEmbedding } from './embedding.service';
import { MANAGEMENT_TENANT_ID } from '@/lib/tenant';
import {
  SUGGESTION_DEFAULT_LIMIT,
  SUGGESTION_SCORE_THRESHOLD,
  assignPercentileTiers,
  applyMinimumGuarantee,
  classifyTier,
  type SuggestionTier,
} from '@/config/suggestion';
// ADR-0021 (2026-05-26): ファイル/添付キーワード検出で attachment scope に絞る
import { detectFileScopeQuery } from '@/config/file-storage-pricing';

// ================================================================
// 公開型
// ================================================================

export type ChatSearchKind =
  | 'project'
  | 'knowledge'
  | 'risk'
  | 'issue'
  | 'retrospective'
  | 'memo'
  // ADR-0021 (2026-05-26): 添付ファイル本体 embedding を新規 scope として追加
  | 'attachment';

/** 結果カード 1 件の共通形状。 */
export interface ChatSearchHit {
  kind: ChatSearchKind;
  id: string;
  title: string;
  snippet: string;
  score: number;
  tier: SuggestionTier;
  /** 由来プロジェクト名 (RiskIssue / Retrospective 用)。Memo / Project は null。 */
  sourceProjectId?: string | null;
  sourceProjectName?: string | null;
  /** Memo の場合の作成者 ID (UI 表示用)。 */
  authorUserId?: string | null;
}

export interface ChatSearchResult {
  query: string;
  /** true なら embedding 生成に失敗し pg_trgm fallback で動作。 */
  degraded: boolean;
  /**
   * 縮退モード時の理由 (UI のバナー文言に使用)。
   * ADR-0019 (2026-05-24): 'fair_use_limit_exceeded' を追加 (チャット検索は無料化されたため、
   *   通常は Beginner 上限 / 予算上限ではなく fair-use-limit で停止)。
   */
  degradeReason?:
    | 'rate_limited'
    | 'beginner_limit_exceeded'
    | 'budget_exceeded'
    | 'tenant_inactive'
    | 'plan_invalid'
    | 'fair_use_limit_exceeded'
    | 'llm_error'
    | 'output_invalid';
  results: {
    projects: ChatSearchHit[];
    knowledges: ChatSearchHit[];
    risksIssues: ChatSearchHit[];
    retrospectives: ChatSearchHit[];
    memos: ChatSearchHit[];
    // ADR-0021 (2026-05-26): file scope query 検出時のみ非空、通常検索では常に空配列
    attachments: ChatSearchHit[];
  };
  /**
   * ADR-0021 (2026-05-26): file scope query (= 「ファイル」「添付」「PDF」等) を検出したか。
   * UI は本フラグで attachment 一覧 / 通常 5 資産の表示切替を行う。
   */
  fileScopeApplied: boolean;
  /** 全資産の合計件数 (UI で「N件の関連資産が見つかりました」表示用)。 */
  totalCount: number;
}

export interface ChatSearchInput {
  query: string;
  viewerTenantId: string;
  viewerUserId: string;
  viewerSeedDataEnabled: boolean;
  /** 各資産あたりの上限件数。default SUGGESTION_DEFAULT_LIMIT (= 50)。 */
  limit?: number;
}

// ================================================================
// 内部: pgvector / pg_trgm クエリ
// ================================================================

/**
 * 検索対象テーブル名 (SQL injection 対策で TypeScript union 型として静的固定)。
 * embedding.service.ts と独立して定義 (visibility フィルタ等が違うため)。
 */
type SearchTable =
  | 'projects'
  | 'knowledges'
  | 'risks_issues'
  | 'retrospectives'
  | 'memos'
  // ADR-0021 (2026-05-26): attachment content_embedding scope
  | 'attachments';

interface RawHit {
  id: string;
  score: number;
}

/**
 * tenantId IN (viewerTenantId, MANAGEMENT_TENANT_ID?) の SQL 値配列を組み立てる。
 * seedDataEnabled=true なら管理テナントも含める (既存提案機能と整合)。
 */
function buildTenantIdList(viewerTenantId: string, seedDataEnabled: boolean): string[] {
  return seedDataEnabled ? [viewerTenantId, MANAGEMENT_TENANT_ID] : [viewerTenantId];
}

/**
 * pgvector Cosine 類似度で検索し、上位 limit 件を取得する。
 * テーブルごとに visibility フィルタが異なるため、本サービス内に閉じた実装にする
 * (embedding.service.ts の searchSimilar は visibility を持たないため流用しない)。
 */
async function pgvectorSearch(
  table: SearchTable,
  queryEmbeddingText: string,
  tenantIds: string[],
  viewerUserId: string,
  limit: number,
): Promise<RawHit[]> {
  switch (table) {
    case 'projects':
      return prisma.$queryRaw<RawHit[]>`
        SELECT id::text AS id,
               1 - (("content_embedding" <=> ${queryEmbeddingText}::vector) / 2) AS score
        FROM "projects"
        WHERE "content_embedding" IS NOT NULL
          AND "tenant_id" = ANY(${tenantIds}::uuid[])
          AND "deleted_at" IS NULL
        ORDER BY "content_embedding" <=> ${queryEmbeddingText}::vector
        LIMIT ${limit}
      `;
    case 'knowledges':
      return prisma.$queryRaw<RawHit[]>`
        SELECT id::text AS id,
               1 - (("content_embedding" <=> ${queryEmbeddingText}::vector) / 2) AS score
        FROM "knowledges"
        WHERE "content_embedding" IS NOT NULL
          AND "tenant_id" = ANY(${tenantIds}::uuid[])
          AND "deleted_at" IS NULL
          AND "visibility" = 'public'
        ORDER BY "content_embedding" <=> ${queryEmbeddingText}::vector
        LIMIT ${limit}
      `;
    case 'risks_issues':
      return prisma.$queryRaw<RawHit[]>`
        SELECT id::text AS id,
               1 - (("content_embedding" <=> ${queryEmbeddingText}::vector) / 2) AS score
        FROM "risks_issues"
        WHERE "content_embedding" IS NOT NULL
          AND "tenant_id" = ANY(${tenantIds}::uuid[])
          AND "deleted_at" IS NULL
          AND "visibility" = 'public'
        ORDER BY "content_embedding" <=> ${queryEmbeddingText}::vector
        LIMIT ${limit}
      `;
    case 'retrospectives':
      return prisma.$queryRaw<RawHit[]>`
        SELECT id::text AS id,
               1 - (("content_embedding" <=> ${queryEmbeddingText}::vector) / 2) AS score
        FROM "retrospectives"
        WHERE "content_embedding" IS NOT NULL
          AND "tenant_id" = ANY(${tenantIds}::uuid[])
          AND "deleted_at" IS NULL
          AND "visibility" = 'public'
        ORDER BY "content_embedding" <=> ${queryEmbeddingText}::vector
        LIMIT ${limit}
      `;
    case 'memos':
      // Memo は visibility='public' に加えて、自分が author の private memo も含める。
      // attachment.service.ts と整合 (= 自分のメモを意味検索で思い出せる UX)。
      return prisma.$queryRaw<RawHit[]>`
        SELECT id::text AS id,
               1 - (("content_embedding" <=> ${queryEmbeddingText}::vector) / 2) AS score
        FROM "memos"
        WHERE "content_embedding" IS NOT NULL
          AND "tenant_id" = ANY(${tenantIds}::uuid[])
          AND "deleted_at" IS NULL
          AND ("visibility" = 'public' OR "user_id" = ${viewerUserId}::uuid)
        ORDER BY "content_embedding" <=> ${queryEmbeddingText}::vector
        LIMIT ${limit}
      `;
    case 'attachments':
      // ADR-0021 (2026-05-26): file scope query 時のみ呼ばれる。
      // storageProvider='supabase' かつ embeddingStatus='completed' を対象。
      // 添付の親 entity 認可は表示時の Pre-signed URL 発行で別途検証する。
      return prisma.$queryRaw<RawHit[]>`
        SELECT id::text AS id,
               1 - (("content_embedding" <=> ${queryEmbeddingText}::vector) / 2) AS score
        FROM "attachments"
        WHERE "content_embedding" IS NOT NULL
          AND "tenant_id" = ANY(${tenantIds}::uuid[])
          AND "deleted_at" IS NULL
          AND "storage_provider" = 'supabase'
          AND "embedding_status" = 'completed'
        ORDER BY "content_embedding" <=> ${queryEmbeddingText}::vector
        LIMIT ${limit}
      `;
    default: {
      const _exhaustive: never = table;
      throw new Error(`Invalid table for chat search: ${String(_exhaustive)}`);
    }
  }
}

/**
 * pg_trgm fallback (縮退モード時)。embedding 不要、テキスト類似度のみで検索する。
 * 各テーブルから limit*3 件取得後 score >= threshold でフィルタして上位を返す。
 */
async function pgTrgmSearch(
  table: SearchTable,
  query: string,
  tenantIds: string[],
  viewerUserId: string,
  limit: number,
): Promise<RawHit[]> {
  switch (table) {
    case 'projects':
      return prisma.$queryRaw<RawHit[]>`
        SELECT id::text AS id,
               similarity(${query}, COALESCE("purpose", '') || ' ' || COALESCE("background", '') || ' ' || COALESCE("scope", ''))::float AS score
        FROM "projects"
        WHERE "tenant_id" = ANY(${tenantIds}::uuid[])
          AND "deleted_at" IS NULL
        ORDER BY score DESC
        LIMIT ${limit}
      `;
    case 'knowledges':
      return prisma.$queryRaw<RawHit[]>`
        SELECT id::text AS id,
               similarity(${query}, "title" || ' ' || "content")::float AS score
        FROM "knowledges"
        WHERE "tenant_id" = ANY(${tenantIds}::uuid[])
          AND "deleted_at" IS NULL
          AND "visibility" = 'public'
        ORDER BY score DESC
        LIMIT ${limit}
      `;
    case 'risks_issues':
      return prisma.$queryRaw<RawHit[]>`
        SELECT id::text AS id,
               similarity(${query}, "title" || ' ' || "content")::float AS score
        FROM "risks_issues"
        WHERE "tenant_id" = ANY(${tenantIds}::uuid[])
          AND "deleted_at" IS NULL
          AND "visibility" = 'public'
        ORDER BY score DESC
        LIMIT ${limit}
      `;
    case 'retrospectives':
      return prisma.$queryRaw<RawHit[]>`
        SELECT id::text AS id,
               similarity(${query}, COALESCE("problems", '') || ' ' || COALESCE("improvements", ''))::float AS score
        FROM "retrospectives"
        WHERE "tenant_id" = ANY(${tenantIds}::uuid[])
          AND "deleted_at" IS NULL
          AND "visibility" = 'public'
        ORDER BY score DESC
        LIMIT ${limit}
      `;
    case 'memos':
      return prisma.$queryRaw<RawHit[]>`
        SELECT id::text AS id,
               similarity(${query}, "title" || ' ' || "content")::float AS score
        FROM "memos"
        WHERE "tenant_id" = ANY(${tenantIds}::uuid[])
          AND "deleted_at" IS NULL
          AND ("visibility" = 'public' OR "user_id" = ${viewerUserId}::uuid)
        ORDER BY score DESC
        LIMIT ${limit}
      `;
    case 'attachments':
      // ADR-0021 (2026-05-26): embedding が無い場合の fallback。
      // 添付には本文 column が無いため display_name のみで類似度判定 (= 精度は低いが degraded mode)。
      return prisma.$queryRaw<RawHit[]>`
        SELECT id::text AS id,
               similarity(${query}, "display_name")::float AS score
        FROM "attachments"
        WHERE "tenant_id" = ANY(${tenantIds}::uuid[])
          AND "deleted_at" IS NULL
          AND "storage_provider" = 'supabase'
        ORDER BY score DESC
        LIMIT ${limit}
      `;
    default: {
      const _exhaustive: never = table;
      throw new Error(`Invalid table for chat search trgm: ${String(_exhaustive)}`);
    }
  }
}

// ================================================================
// 内部: 各 hit の本体情報を取得して ChatSearchHit に整形
// ================================================================

async function loadProjects(hits: RawHit[], tenantIds: string[]): Promise<ChatSearchHit[]> {
  if (hits.length === 0) return [];
  const ids = hits.map((h) => h.id);
  // tenantId は pgvector の WHERE で既に絞られているが、defense-in-depth で findMany にも付与
  // ([feedback_tenant_isolation.md] severity-1 invariant: 全 findMany に tenantId フィルタ必須)
  const rows = await prisma.project.findMany({
    where: { id: { in: ids }, tenantId: { in: tenantIds }, deletedAt: null },
    select: { id: true, name: true, purpose: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return hits.flatMap((h) => {
    const row = byId.get(h.id);
    if (!row) return [];
    return [{
      kind: 'project' as const,
      id: row.id,
      title: row.name,
      snippet: row.purpose.slice(0, 120),
      score: h.score,
      tier: classifyTier(h.score),
      sourceProjectId: null,
      sourceProjectName: null,
      authorUserId: null,
    }];
  });
}

async function loadKnowledges(hits: RawHit[], tenantIds: string[]): Promise<ChatSearchHit[]> {
  if (hits.length === 0) return [];
  const ids = hits.map((h) => h.id);
  // defense-in-depth: pgvector / pg_trgm で visibility='public' に絞ったが、
  // 競合更新で draft 化された行を絶対に通さないため findMany でも明示
  const rows = await prisma.knowledge.findMany({
    where: { id: { in: ids }, tenantId: { in: tenantIds }, deletedAt: null, visibility: 'public' },
    select: { id: true, title: true, content: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return hits.flatMap((h) => {
    const row = byId.get(h.id);
    if (!row) return [];
    return [{
      kind: 'knowledge' as const,
      id: row.id,
      title: row.title,
      snippet: row.content.slice(0, 120),
      score: h.score,
      tier: classifyTier(h.score),
      sourceProjectId: null,
      sourceProjectName: null,
      authorUserId: null,
    }];
  });
}

async function loadRisksIssues(hits: RawHit[], tenantIds: string[]): Promise<ChatSearchHit[]> {
  if (hits.length === 0) return [];
  const ids = hits.map((h) => h.id);
  // defense-in-depth: pgvector / pg_trgm で visibility='public' に絞ったが、
  // 競合更新で draft 化された行を絶対に通さないため findMany でも明示
  const rows = await prisma.riskIssue.findMany({
    where: { id: { in: ids }, tenantId: { in: tenantIds }, deletedAt: null, visibility: 'public' },
    select: {
      id: true,
      type: true,
      title: true,
      content: true,
      projectId: true,
      project: { select: { name: true, deletedAt: true } },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return hits.flatMap((h) => {
    const row = byId.get(h.id);
    if (!row) return [];
    return [{
      kind: (row.type === 'risk' ? 'risk' : 'issue') as ChatSearchKind,
      id: row.id,
      title: row.title,
      snippet: row.content.slice(0, 120),
      score: h.score,
      tier: classifyTier(h.score),
      sourceProjectId: row.projectId,
      sourceProjectName: row.project?.deletedAt ? null : row.project?.name ?? null,
      authorUserId: null,
    }];
  });
}

async function loadRetrospectives(hits: RawHit[], tenantIds: string[]): Promise<ChatSearchHit[]> {
  if (hits.length === 0) return [];
  const ids = hits.map((h) => h.id);
  // defense-in-depth: pgvector / pg_trgm で visibility='public' に絞ったが、
  // 競合更新で draft 化された行を絶対に通さないため findMany でも明示
  const rows = await prisma.retrospective.findMany({
    where: { id: { in: ids }, tenantId: { in: tenantIds }, deletedAt: null, visibility: 'public' },
    select: {
      id: true,
      conductedDate: true,
      problems: true,
      improvements: true,
      projectId: true,
      project: { select: { name: true, deletedAt: true } },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r] as const));
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
      sourceProjectId: row.projectId,
      sourceProjectName: row.project?.deletedAt ? null : row.project?.name ?? null,
      authorUserId: null,
    }];
  });
}

async function loadMemos(
  hits: RawHit[],
  tenantIds: string[],
  viewerUserId: string,
): Promise<ChatSearchHit[]> {
  if (hits.length === 0) return [];
  const ids = hits.map((h) => h.id);
  // defense-in-depth: pgvector / pg_trgm で visibility='public' OR userId=viewerUserId
  // に絞ったが、競合更新で private 化された他人のメモを絶対に通さないため findMany でも明示
  const rows = await prisma.memo.findMany({
    where: {
      id: { in: ids },
      tenantId: { in: tenantIds },
      deletedAt: null,
      OR: [{ visibility: 'public' }, { userId: viewerUserId }],
    },
    select: { id: true, title: true, content: true, userId: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return hits.flatMap((h) => {
    const row = byId.get(h.id);
    if (!row) return [];
    return [{
      kind: 'memo' as const,
      id: row.id,
      title: row.title,
      snippet: row.content.slice(0, 120),
      score: h.score,
      tier: classifyTier(h.score),
      sourceProjectId: null,
      sourceProjectName: null,
      authorUserId: row.userId,
    }];
  });
}

/**
 * Attachment hits を ChatSearchHit へ整形 (ADR-0021 §9.5)。
 * defense-in-depth: tenantId + storageProvider='supabase' + deletedAt=null + embeddingStatus='completed'
 * を findMany でも再度フィルタ (= pgvector で絞っていても安全のため明示)。
 */
async function loadAttachments(
  hits: RawHit[],
  tenantIds: string[],
): Promise<ChatSearchHit[]> {
  if (hits.length === 0) return [];
  const ids = hits.map((h) => h.id);
  const rows = await prisma.attachment.findMany({
    where: {
      id: { in: ids },
      tenantId: { in: tenantIds },
      deletedAt: null,
      storageProvider: 'supabase',
    },
    select: {
      id: true,
      displayName: true,
      entityType: true,
      entityId: true,
      mimeHint: true,
      sizeBytes: true,
      addedBy: true,
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return hits.flatMap((h) => {
    const row = byId.get(h.id);
    if (!row) return [];
    const sizeKb = row.sizeBytes ? Math.ceil(Number(row.sizeBytes) / 1000) : null;
    const snippet = `${row.entityType} 添付 ${row.mimeHint ?? ''}${sizeKb ? ` (${sizeKb}KB)` : ''}`.trim();
    return [{
      kind: 'attachment' as const,
      id: row.id,
      title: row.displayName,
      snippet,
      score: h.score,
      tier: classifyTier(h.score),
      sourceProjectId: null,
      sourceProjectName: null,
      authorUserId: row.addedBy,
    }];
  });
}

// ================================================================
// 公開関数
// ================================================================

/**
 * 5 資産横断のチャット意味検索を実行する。
 *
 * 認可前提: 呼び出し側 (API ルート) で getAuthenticatedUser() 済。
 * 本サービスは検索ロジックのみを担当。
 */
export async function chatSemanticSearch(
  input: ChatSearchInput,
): Promise<ChatSearchResult> {
  const trimmed = input.query.trim();
  const limit = input.limit ?? SUGGESTION_DEFAULT_LIMIT;
  const tenantIds = buildTenantIdList(input.viewerTenantId, input.viewerSeedDataEnabled);

  // ADR-0021 (2026-05-26): file scope query 検出 (= 「ファイル」「添付」「PDF」等)
  //   true: 添付ファイルのみ検索、他資産は空
  //   false: 既存 5 資産横断検索 (= 既存挙動)
  const fileScopeApplied = detectFileScopeQuery(trimmed);

  if (trimmed.length === 0) {
    return {
      query: input.query,
      degraded: false,
      results: {
        projects: [],
        knowledges: [],
        risksIssues: [],
        retrospectives: [],
        memos: [],
        attachments: [],
      },
      totalCount: 0,
      fileScopeApplied: false,
    };
  }

  // クエリ embedding 生成 (1 ApiCallLog 計上 = 仕様 §4 全プラン計上)
  const embeddingResult = await generateEmbedding({
    text: trimmed,
    featureUnit: 'chat-semantic-search',
    tenantId: input.viewerTenantId,
    userId: input.viewerUserId,
    inputType: 'query',
  });

  if (embeddingResult.ok) {
    const vectorText = `[${embeddingResult.embedding.join(',')}]`;

    // file scope query: attachment のみ検索 (= ADR-0021 §9.5.2)
    if (fileScopeApplied) {
      const attHits = await pgvectorSearch(
        'attachments',
        vectorText,
        tenantIds,
        input.viewerUserId,
        limit,
      );
      const attachments = await loadAttachments(attHits, tenantIds).then((arr) =>
        assignPercentileTiers(applyMinimumGuarantee(arr, SUGGESTION_SCORE_THRESHOLD)),
      );
      return {
        query: input.query,
        degraded: false,
        results: {
          projects: [],
          knowledges: [],
          risksIssues: [],
          retrospectives: [],
          memos: [],
          attachments,
        },
        totalCount: attachments.length,
        fileScopeApplied: true,
      };
    }

    // 通常検索: 5 資産並列 (attachment は含めない)
    const [projectHits, knowledgeHits, riskIssueHits, retroHits, memoHits] = await Promise.all([
      pgvectorSearch('projects', vectorText, tenantIds, input.viewerUserId, limit),
      pgvectorSearch('knowledges', vectorText, tenantIds, input.viewerUserId, limit),
      pgvectorSearch('risks_issues', vectorText, tenantIds, input.viewerUserId, limit),
      pgvectorSearch('retrospectives', vectorText, tenantIds, input.viewerUserId, limit),
      pgvectorSearch('memos', vectorText, tenantIds, input.viewerUserId, limit),
    ]);

    const [projects, knowledges, risksIssues, retrospectives, memos] = await Promise.all([
      loadProjects(projectHits, tenantIds).then((arr) => assignPercentileTiers(applyMinimumGuarantee(arr, SUGGESTION_SCORE_THRESHOLD))),
      loadKnowledges(knowledgeHits, tenantIds).then((arr) => assignPercentileTiers(applyMinimumGuarantee(arr, SUGGESTION_SCORE_THRESHOLD))),
      loadRisksIssues(riskIssueHits, tenantIds).then((arr) => assignPercentileTiers(applyMinimumGuarantee(arr, SUGGESTION_SCORE_THRESHOLD))),
      loadRetrospectives(retroHits, tenantIds).then((arr) => assignPercentileTiers(applyMinimumGuarantee(arr, SUGGESTION_SCORE_THRESHOLD))),
      loadMemos(memoHits, tenantIds, input.viewerUserId).then((arr) => assignPercentileTiers(applyMinimumGuarantee(arr, SUGGESTION_SCORE_THRESHOLD))),
    ]);

    return {
      query: input.query,
      degraded: false,
      results: { projects, knowledges, risksIssues, retrospectives, memos, attachments: [] },
      totalCount: projects.length + knowledges.length + risksIssues.length + retrospectives.length + memos.length,
      fileScopeApplied: false,
    };
  }

  // 縮退モード: pg_trgm fallback (テキスト類似度のみ)
  if (fileScopeApplied) {
    const attHits = await pgTrgmSearch(
      'attachments',
      trimmed,
      tenantIds,
      input.viewerUserId,
      limit,
    );
    const attachments = await loadAttachments(attHits, tenantIds).then((arr) =>
      assignPercentileTiers(applyMinimumGuarantee(arr, SUGGESTION_SCORE_THRESHOLD)),
    );
    return {
      query: input.query,
      degraded: true,
      degradeReason: embeddingResult.reason,
      results: {
        projects: [],
        knowledges: [],
        risksIssues: [],
        retrospectives: [],
        memos: [],
        attachments,
      },
      totalCount: attachments.length,
      fileScopeApplied: true,
    };
  }

  const [projectHits, knowledgeHits, riskIssueHits, retroHits, memoHits] = await Promise.all([
    pgTrgmSearch('projects', trimmed, tenantIds, input.viewerUserId, limit),
    pgTrgmSearch('knowledges', trimmed, tenantIds, input.viewerUserId, limit),
    pgTrgmSearch('risks_issues', trimmed, tenantIds, input.viewerUserId, limit),
    pgTrgmSearch('retrospectives', trimmed, tenantIds, input.viewerUserId, limit),
    pgTrgmSearch('memos', trimmed, tenantIds, input.viewerUserId, limit),
  ]);

  const [projects, knowledges, risksIssues, retrospectives, memos] = await Promise.all([
    loadProjects(projectHits, tenantIds).then((arr) => assignPercentileTiers(applyMinimumGuarantee(arr, SUGGESTION_SCORE_THRESHOLD))),
    loadKnowledges(knowledgeHits, tenantIds).then((arr) => assignPercentileTiers(applyMinimumGuarantee(arr, SUGGESTION_SCORE_THRESHOLD))),
    loadRisksIssues(riskIssueHits, tenantIds).then((arr) => assignPercentileTiers(applyMinimumGuarantee(arr, SUGGESTION_SCORE_THRESHOLD))),
    loadRetrospectives(retroHits, tenantIds).then((arr) => assignPercentileTiers(applyMinimumGuarantee(arr, SUGGESTION_SCORE_THRESHOLD))),
    loadMemos(memoHits, tenantIds, input.viewerUserId).then((arr) => assignPercentileTiers(applyMinimumGuarantee(arr, SUGGESTION_SCORE_THRESHOLD))),
  ]);

  return {
    query: input.query,
    degraded: true,
    degradeReason: embeddingResult.reason,
    results: { projects, knowledges, risksIssues, retrospectives, memos, attachments: [] },
    totalCount: projects.length + knowledges.length + risksIssues.length + retrospectives.length + memos.length,
    fileScopeApplied: false,
  };
}
