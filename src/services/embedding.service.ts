/**
 * Embedding 生成・類似検索サービス (PR #4 / T-03 提案エンジン v2 Phase 2)
 *
 * 役割:
 *   1. テキスト → ベクトル変換 (Voyage AI voyage-4-lite, 1024 次元)
 *   2. pgvector による Cosine Similarity 検索 (テナント境界 + 軟削除フィルタ)
 *   3. withMeteredLLM 経由でテナント認可・課金・rate limit を一元化
 *
 * 設計方針:
 *
 *   - **生成**: 入力 text を MAX_INPUT_CHARS で truncate し、Voyage API で 1024 次元ベクトルへ変換。
 *   - **保存**: Prisma 経由で `Unsupported("vector(1024)")` カラムを直接 update できないため、
 *     `$executeRawUnsafe` で型 cast (text → vector) しつつ書き込む。SQL injection を避けるため
 *     ベクトルは数値配列を `[1.234,...]` 形式の文字列に整形して bind する。
 *   - **検索**: `<=>` 演算子 (cosine distance、0=同一 / 2=反対) を使い ORDER BY で上位 N を取得。
 *     Score への変換は `1 - distance / 2` で 0.0-1.0 の similarity に正規化。
 *   - **テナント境界**: `WHERE tenant_id = $tenantId AND deleted_at IS NULL` を必須付与。
 *     呼び出し側で `requireSameTenant` も併用し二重防御。
 *   - **NULL 許容**: content_embedding が NULL の行は検索対象外 (新規未生成 / 生成失敗時の漏れ込み防止)。
 *
 * 失敗時のフォールバック:
 *   - 生成失敗 (rate_limited / llm_error 等) は AutoTagSuccess と同様 union 型で返却。
 *     呼び出し側は既存スコアリング (タグ Jaccard / pg_trgm) のみで動作継続する。
 *
 * 関連:
 *   - 設計: docs/design/SUGGESTION_ENGINE.md §Phase 2
 *   - 計画: docs/roadmap/SUGGESTION_ENGINE_PLAN.md PR #4
 *   - クライアント: src/lib/llm/voyage-client.ts
 *   - ミドルウェア: src/lib/llm/metered.ts (withMeteredLLM)
 *   - スキーマ: prisma/schema.prisma (Project / Knowledge / RiskIssue / Retrospective / Memo)
 *   - migration: prisma/migrations/20260502_pgvector_embedding/migration.sql
 */

import { prisma } from '@/lib/db';
import { withMeteredLLM } from '@/lib/llm/metered';
import { voyageEmbed } from '@/lib/llm/voyage-client';
import { EMBEDDING_DIMENSIONS } from '@/config/llm';

// ================================================================
// 公開型
// ================================================================

export interface GenerateEmbeddingInput {
  /** ベクトル化する text (purpose + background + scope を結合した文字列等)。 */
  text: string;
  /** featureUnit 識別子。ApiCallLog に記録され、課金分類のキーになる。 */
  featureUnit: string;
  /** リクエストユーザの所属テナント ID。 */
  tenantId: string;
  /** リクエストユーザの ID。cron / システム実行は undefined。 */
  userId?: string;
  /** 'document' (デフォルト、検索対象側) / 'query' (検索クエリ側)。 */
  inputType?: 'document' | 'query';
}

export interface GenerateEmbeddingSuccess {
  ok: true;
  embedding: number[];
  costJpy: number;
  requestId: string;
}

export interface GenerateEmbeddingFailure {
  ok: false;
  reason:
    | 'rate_limited'
    | 'tenant_inactive'
    | 'beginner_limit_exceeded'
    | 'budget_exceeded'
    | 'plan_invalid'
    | 'llm_error'
    | 'output_invalid';
  message: string;
}

export type GenerateEmbeddingResult =
  | GenerateEmbeddingSuccess
  | GenerateEmbeddingFailure;

/** Cosine Similarity 検索の結果 1 件。 */
export interface SimilarityHit {
  /** ヒットした行の id。 */
  id: string;
  /** 0.0 〜 1.0 の類似度スコア (1 = 完全一致、0 = 直交)。 */
  score: number;
}

/** 検索対象テーブル名のホワイトリスト (SQL injection 対策で固定値のみ許可)。 */
export type EmbeddingSearchTable =
  | 'projects'
  | 'knowledges'
  | 'risks_issues'
  | 'retrospectives'
  | 'memos';

const ALLOWED_TABLES: ReadonlyArray<EmbeddingSearchTable> = [
  'projects',
  'knowledges',
  'risks_issues',
  'retrospectives',
  'memos',
];

// ================================================================
// 内部定数
// ================================================================

/**
 * 入力 text の最大文字数。これを超えた分は API 呼び出し前に truncate。
 *
 * 根拠:
 *   - voyage-4-lite は context 32K tokens 対応だが、運用上 1 entity のテキストが
 *     1 万文字を超えるケースは稀。コスト爆発 (DoS) を抑えるため上限を設ける。
 *   - 8000 文字 ≒ 12000 tokens (日本語混在)、200M 無料枠なら ~16,000 リクエスト
 */
export const MAX_INPUT_CHARS = 8000;

// ================================================================
// 公開関数: 生成
// ================================================================

/**
 * テキストから embedding を生成する。
 *
 * - 入力 text を MAX_INPUT_CHARS で truncate
 * - withMeteredLLM 経由で voyage-4-lite を呼び出し
 * - 縮退時は呼び出し元が「embedding なしで動作継続」のフォールバックを行うこと
 */
export async function generateEmbedding(
  input: GenerateEmbeddingInput,
): Promise<GenerateEmbeddingResult> {
  const truncated = input.text.length > MAX_INPUT_CHARS
    ? input.text.slice(0, MAX_INPUT_CHARS)
    : input.text;

  // 空文字 / 空白のみは voyage 呼び出し不要 (どうせ意味的に空)
  if (truncated.trim().length === 0) {
    return {
      ok: false,
      reason: 'output_invalid',
      message: '入力 text が空のため embedding を生成できません',
    };
  }

  const result = await withMeteredLLM(
    {
      featureUnit: input.featureUnit,
      tenantId: input.tenantId,
      userId: input.userId,
    },
    async ({ requestId }) => {
      const voyage = await voyageEmbed({
        texts: [truncated],
        inputType: input.inputType ?? 'document',
      });
      return {
        result: voyage.embeddings[0]!,
        usage: { embeddingTokens: voyage.totalTokens },
        requestId,
      };
    },
  );

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      message: 'message' in result ? result.message : 'embedding 生成に失敗しました',
    };
  }

  // sanity check: voyage-client 側でも検証しているが、二重防御
  if (result.result.length !== EMBEDDING_DIMENSIONS) {
    return {
      ok: false,
      reason: 'output_invalid',
      message: `embedding 次元異常: expected ${EMBEDDING_DIMENSIONS}, got ${result.result.length}`,
    };
  }

  return {
    ok: true,
    embedding: result.result,
    costJpy: result.costJpy,
    requestId: result.requestId,
  };
}

// ================================================================
// 公開関数: DB への embedding 書き込み
// ================================================================

/**
 * 既存行の content_embedding カラムを更新する。
 *
 * Prisma の `Unsupported("vector(1024)")` 型は `update()` で直接書けないため、
 * `$executeRawUnsafe` で text → vector cast を行う。テーブル名は ホワイトリスト 検証で
 * SQL injection を防ぎ、ベクトル値は parametrized binding で渡す。
 *
 * @returns 更新行数 (0 なら id 不在 or テナント不一致 = サイレント失敗)
 */
export async function persistEmbedding(
  table: EmbeddingSearchTable,
  rowId: string,
  tenantId: string,
  embedding: number[],
): Promise<number> {
  if (!ALLOWED_TABLES.includes(table)) {
    throw new Error(`Invalid table for embedding: ${table}`);
  }
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `embedding length ${embedding.length} != ${EMBEDDING_DIMENSIONS}`,
    );
  }

  // ベクトルを '[1.234,5.678,...]' 形式の文字列に整形 (pgvector text 入力形式)
  const vectorText = `[${embedding.join(',')}]`;

  // テーブル名は white-list 検証済のため identifier として安全にスニペット化可。
  // 値は $1 / $2 / $3 で parametrized bind。
  return prisma.$executeRawUnsafe(
    `UPDATE "${table}" SET "content_embedding" = $1::vector WHERE id = $2::uuid AND tenant_id = $3::uuid`,
    vectorText,
    rowId,
    tenantId,
  );
}

// ================================================================
// 公開関数: Cosine Similarity 検索
// ================================================================

export interface SearchSimilarOptions {
  /** 検索対象テーブル (white list)。 */
  table: EmbeddingSearchTable;
  /** クエリベクトル (1024 次元)。 */
  queryEmbedding: number[];
  /** テナント境界 (必須)。 */
  tenantId: string;
  /** 取得上限件数。default 20。 */
  limit?: number;
  /** 類似度スコア下限 (0.0-1.0)。これ未満は除外。default 0.0。 */
  minScore?: number;
  /** id 除外リスト (例: 元プロジェクト自身を結果から除く)。 */
  excludeIds?: ReadonlyArray<string>;
}

/**
 * pgvector の Cosine Similarity 検索。
 *
 * - `<=>` 演算子で cosine distance (0=完全一致 / 2=正反対) を取得
 * - `1 - distance / 2` で 0.0-1.0 の similarity に正規化
 * - テナント境界 + soft-delete フィルタを必須付与
 * - content_embedding IS NULL の行は除外
 *
 * @returns score 降順の SimilarityHit[]
 */
export async function searchSimilar(
  options: SearchSimilarOptions,
): Promise<SimilarityHit[]> {
  if (!ALLOWED_TABLES.includes(options.table)) {
    throw new Error(`Invalid table for similarity search: ${options.table}`);
  }
  if (options.queryEmbedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `query embedding length ${options.queryEmbedding.length} != ${EMBEDDING_DIMENSIONS}`,
    );
  }

  const limit = options.limit ?? 20;
  const minScore = options.minScore ?? 0.0;
  const vectorText = `[${options.queryEmbedding.join(',')}]`;
  const excludeIds = options.excludeIds ?? [];

  // 除外句は配列を JSON として bind し PostgreSQL 側で `!= ANY(...)` で展開。
  // 個数 0 のときは TRUE で no-op。
  const excludeClause =
    excludeIds.length > 0 ? 'AND id <> ALL($4::uuid[])' : '';

  const sql = `
    SELECT
      id::text AS id,
      1 - (("content_embedding" <=> $1::vector) / 2) AS score
    FROM "${options.table}"
    WHERE
      "content_embedding" IS NOT NULL
      AND "tenant_id" = $2::uuid
      AND "deleted_at" IS NULL
      ${excludeClause}
    ORDER BY "content_embedding" <=> $1::vector
    LIMIT $3
  `;

  const rows = excludeIds.length > 0
    ? await prisma.$queryRawUnsafe<Array<{ id: string; score: number }>>(
      sql,
      vectorText,
      options.tenantId,
      limit,
      excludeIds,
    )
    : await prisma.$queryRawUnsafe<Array<{ id: string; score: number }>>(
      sql,
      vectorText,
      options.tenantId,
      limit,
    );

  return rows
    .map((r) => ({ id: r.id, score: Number(r.score) }))
    .filter((r) => r.score >= minScore);
}
