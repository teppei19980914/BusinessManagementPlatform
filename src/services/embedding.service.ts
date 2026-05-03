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
 *     tagged template の生 SQL (parametrized binding) で型 cast (text → vector) しつつ書き込む。
 *     SQL injection 対策として、テーブル名は TypeScript union + exhaustive switch で静的固定し、
 *     値はすべて自動 parametrized binding。ベクトルは数値配列を `[1.234,...]` 形式の
 *     文字列に整形して bind する。
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
import { recordError } from './error-log.service';

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

/**
 * 検索対象テーブル名 (SQL injection 対策で TypeScript union 型として静的固定)。
 * persistEmbedding / searchSimilar はこの union を exhaustive switch で分岐し、
 * SQL 文中の identifier (テーブル名) を動的補間しない設計。
 */
export type EmbeddingSearchTable =
  | 'projects'
  | 'knowledges'
  | 'risks_issues'
  | 'retrospectives'
  | 'memos';

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
 * `$executeRaw` のタグ付きテンプレートリテラルで text → vector cast を行う。
 *
 * **SQL injection 対策**:
 *   - テーブル名は TypeScript の union 型 + exhaustive switch で **静的に固定**
 *     し、動的な identifier 補間を完全に排除する (= injection 経路ゼロ)。
 *   - 値はタグ付きテンプレートで自動 parametrized binding ($1 / $2 / $3)。
 *
 * @returns 更新行数 (0 なら id 不在 or テナント不一致 = サイレント失敗)
 */
export async function persistEmbedding(
  table: EmbeddingSearchTable,
  rowId: string,
  tenantId: string,
  embedding: number[],
): Promise<number> {
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `embedding length ${embedding.length} != ${EMBEDDING_DIMENSIONS}`,
    );
  }

  // ベクトルを '[1.234,5.678,...]' 形式の文字列に整形 (pgvector text 入力形式)
  const vectorText = `[${embedding.join(',')}]`;

  // テーブル名は TypeScript union で静的固定。switch で exhaustive にし、
  // 動的な identifier 補間を完全に排除 (SQL injection リスクゼロ)。
  switch (table) {
    case 'projects':
      return prisma.$executeRaw`
        UPDATE "projects" SET "content_embedding" = ${vectorText}::vector
        WHERE id = ${rowId}::uuid AND tenant_id = ${tenantId}::uuid
      `;
    case 'knowledges':
      return prisma.$executeRaw`
        UPDATE "knowledges" SET "content_embedding" = ${vectorText}::vector
        WHERE id = ${rowId}::uuid AND tenant_id = ${tenantId}::uuid
      `;
    case 'risks_issues':
      return prisma.$executeRaw`
        UPDATE "risks_issues" SET "content_embedding" = ${vectorText}::vector
        WHERE id = ${rowId}::uuid AND tenant_id = ${tenantId}::uuid
      `;
    case 'retrospectives':
      return prisma.$executeRaw`
        UPDATE "retrospectives" SET "content_embedding" = ${vectorText}::vector
        WHERE id = ${rowId}::uuid AND tenant_id = ${tenantId}::uuid
      `;
    case 'memos':
      return prisma.$executeRaw`
        UPDATE "memos" SET "content_embedding" = ${vectorText}::vector
        WHERE id = ${rowId}::uuid AND tenant_id = ${tenantId}::uuid
      `;
    default: {
      // exhaustive check: TypeScript union 全 case 網羅を強制 (将来 table 拡張時の漏れ検知)
      const _exhaustive: never = table;
      throw new Error(`Invalid table for embedding: ${String(_exhaustive)}`);
    }
  }
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
 * **SQL injection 対策**:
 *   - テーブル名は TypeScript union + exhaustive switch で静的固定
 *   - 動的 identifier 補間を完全排除、すべての値は tagged template の自動 parametrized binding
 *
 * @returns score 降順の SimilarityHit[]
 */
export async function searchSimilar(
  options: SearchSimilarOptions,
): Promise<SimilarityHit[]> {
  if (options.queryEmbedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `query embedding length ${options.queryEmbedding.length} != ${EMBEDDING_DIMENSIONS}`,
    );
  }

  const limit = options.limit ?? 20;
  const minScore = options.minScore ?? 0.0;
  const vectorText = `[${options.queryEmbedding.join(',')}]`;
  const excludeIds = options.excludeIds ?? [];
  const hasExcludes = excludeIds.length > 0;

  // テーブル名は TypeScript union で静的固定。switch で exhaustive にする。
  // excludeIds の有無で 2 経路に分岐 (タグ付きテンプレートでは条件付き SQL 断片の挿入ができないため)。
  let rows: Array<{ id: string; score: number }>;
  switch (options.table) {
    case 'projects':
      rows = hasExcludes
        ? await prisma.$queryRaw<Array<{ id: string; score: number }>>`
          SELECT id::text AS id,
                 1 - (("content_embedding" <=> ${vectorText}::vector) / 2) AS score
          FROM "projects"
          WHERE "content_embedding" IS NOT NULL
            AND "tenant_id" = ${options.tenantId}::uuid
            AND "deleted_at" IS NULL
            AND id <> ALL(${excludeIds}::uuid[])
          ORDER BY "content_embedding" <=> ${vectorText}::vector
          LIMIT ${limit}
        `
        : await prisma.$queryRaw<Array<{ id: string; score: number }>>`
          SELECT id::text AS id,
                 1 - (("content_embedding" <=> ${vectorText}::vector) / 2) AS score
          FROM "projects"
          WHERE "content_embedding" IS NOT NULL
            AND "tenant_id" = ${options.tenantId}::uuid
            AND "deleted_at" IS NULL
          ORDER BY "content_embedding" <=> ${vectorText}::vector
          LIMIT ${limit}
        `;
      break;
    case 'knowledges':
      rows = hasExcludes
        ? await prisma.$queryRaw<Array<{ id: string; score: number }>>`
          SELECT id::text AS id,
                 1 - (("content_embedding" <=> ${vectorText}::vector) / 2) AS score
          FROM "knowledges"
          WHERE "content_embedding" IS NOT NULL
            AND "tenant_id" = ${options.tenantId}::uuid
            AND "deleted_at" IS NULL
            AND id <> ALL(${excludeIds}::uuid[])
          ORDER BY "content_embedding" <=> ${vectorText}::vector
          LIMIT ${limit}
        `
        : await prisma.$queryRaw<Array<{ id: string; score: number }>>`
          SELECT id::text AS id,
                 1 - (("content_embedding" <=> ${vectorText}::vector) / 2) AS score
          FROM "knowledges"
          WHERE "content_embedding" IS NOT NULL
            AND "tenant_id" = ${options.tenantId}::uuid
            AND "deleted_at" IS NULL
          ORDER BY "content_embedding" <=> ${vectorText}::vector
          LIMIT ${limit}
        `;
      break;
    case 'risks_issues':
      rows = hasExcludes
        ? await prisma.$queryRaw<Array<{ id: string; score: number }>>`
          SELECT id::text AS id,
                 1 - (("content_embedding" <=> ${vectorText}::vector) / 2) AS score
          FROM "risks_issues"
          WHERE "content_embedding" IS NOT NULL
            AND "tenant_id" = ${options.tenantId}::uuid
            AND "deleted_at" IS NULL
            AND id <> ALL(${excludeIds}::uuid[])
          ORDER BY "content_embedding" <=> ${vectorText}::vector
          LIMIT ${limit}
        `
        : await prisma.$queryRaw<Array<{ id: string; score: number }>>`
          SELECT id::text AS id,
                 1 - (("content_embedding" <=> ${vectorText}::vector) / 2) AS score
          FROM "risks_issues"
          WHERE "content_embedding" IS NOT NULL
            AND "tenant_id" = ${options.tenantId}::uuid
            AND "deleted_at" IS NULL
          ORDER BY "content_embedding" <=> ${vectorText}::vector
          LIMIT ${limit}
        `;
      break;
    case 'retrospectives':
      rows = hasExcludes
        ? await prisma.$queryRaw<Array<{ id: string; score: number }>>`
          SELECT id::text AS id,
                 1 - (("content_embedding" <=> ${vectorText}::vector) / 2) AS score
          FROM "retrospectives"
          WHERE "content_embedding" IS NOT NULL
            AND "tenant_id" = ${options.tenantId}::uuid
            AND "deleted_at" IS NULL
            AND id <> ALL(${excludeIds}::uuid[])
          ORDER BY "content_embedding" <=> ${vectorText}::vector
          LIMIT ${limit}
        `
        : await prisma.$queryRaw<Array<{ id: string; score: number }>>`
          SELECT id::text AS id,
                 1 - (("content_embedding" <=> ${vectorText}::vector) / 2) AS score
          FROM "retrospectives"
          WHERE "content_embedding" IS NOT NULL
            AND "tenant_id" = ${options.tenantId}::uuid
            AND "deleted_at" IS NULL
          ORDER BY "content_embedding" <=> ${vectorText}::vector
          LIMIT ${limit}
        `;
      break;
    case 'memos':
      rows = hasExcludes
        ? await prisma.$queryRaw<Array<{ id: string; score: number }>>`
          SELECT id::text AS id,
                 1 - (("content_embedding" <=> ${vectorText}::vector) / 2) AS score
          FROM "memos"
          WHERE "content_embedding" IS NOT NULL
            AND "tenant_id" = ${options.tenantId}::uuid
            AND "deleted_at" IS NULL
            AND id <> ALL(${excludeIds}::uuid[])
          ORDER BY "content_embedding" <=> ${vectorText}::vector
          LIMIT ${limit}
        `
        : await prisma.$queryRaw<Array<{ id: string; score: number }>>`
          SELECT id::text AS id,
                 1 - (("content_embedding" <=> ${vectorText}::vector) / 2) AS score
          FROM "memos"
          WHERE "content_embedding" IS NOT NULL
            AND "tenant_id" = ${options.tenantId}::uuid
            AND "deleted_at" IS NULL
          ORDER BY "content_embedding" <=> ${vectorText}::vector
          LIMIT ${limit}
        `;
      break;
    default: {
      const _exhaustive: never = options.table;
      throw new Error(`Invalid table for similarity search: ${String(_exhaustive)}`);
    }
  }

  return rows
    .map((r) => ({ id: r.id, score: Number(r.score) }))
    .filter((r) => r.score >= minScore);
}

// ================================================================
// 公開関数: エンティティ embedding 生成 + 保存の高レベル helper (PR #5-c)
// ================================================================

/**
 * エンティティの content_embedding を生成 + 保存する高レベル helper。
 * Knowledge / RiskIssue / Retrospective / Project すべての service 層から共通利用される。
 *
 * 動作:
 *   1. text を trim、空ならサイレント終了 (LLM 呼び出しなし、課金回避)
 *   2. generateEmbedding (withMeteredLLM 経由 = 課金 / rate limit / ApiCallLog 記録)
 *   3. 失敗時 (rate_limited / llm_error 等) は recordError (warn) でログのみ → return
 *   4. 成功時は persistEmbedding (raw SQL で vector cast)
 *   5. persist 失敗時も recordError (error) でログのみ → return (本体に throw 伝播させない)
 *
 * **fail-safe 設計**:
 *   - embedding の生成 / 保存失敗は本体 INSERT/UPDATE をロールバックさせない
 *   - content_embedding NULL のまま運用継続を許容
 *   - suggestion engine が tag/pg_trgm 軸のみで動作する縮退モードに自動移行
 *
 * @example
 *   await generateAndPersistEntityEmbedding({
 *     table: 'knowledges',
 *     rowId: knowledge.id,
 *     tenantId,
 *     userId,
 *     text: composeKnowledgeText(input),
 *     featureUnit: 'knowledge-embedding',
 *   });
 */
export async function generateAndPersistEntityEmbedding(args: {
  /** 保存先テーブル (white-list 型で SQL injection 経路ゼロ) */
  table: EmbeddingSearchTable;
  /** 対象 row ID (UUID) */
  rowId: string;
  /** テナント境界 (= persistEmbedding の WHERE 条件) */
  tenantId: string;
  /** リクエストユーザ ID (cron / システム実行は undefined) */
  userId?: string;
  /** ベクトル化対象 text (空文字なら呼び出さず終了) */
  text: string;
  /** ApiCallLog に記録される featureUnit ('knowledge-embedding' 等) */
  featureUnit: string;
}): Promise<void> {
  const trimmed = args.text.trim();
  if (trimmed.length === 0) {
    // 全 text 空 (新規 + ユーザがいずれも空文字で送信) の場合は LLM 呼ばず終了
    return;
  }

  const result = await generateEmbedding({
    text: trimmed,
    featureUnit: args.featureUnit,
    tenantId: args.tenantId,
    userId: args.userId,
  });

  if (!result.ok) {
    await recordError({
      severity: 'warn',
      source: 'server',
      message: `embedding generation failed for ${args.table}/${args.rowId}: ${result.reason}`,
      userId: args.userId,
      context: {
        kind: `${args.table}_embedding_failure`,
        table: args.table,
        rowId: args.rowId,
        tenantId: args.tenantId,
        reason: result.reason,
      },
    });
    return;
  }

  try {
    await persistEmbedding(args.table, args.rowId, args.tenantId, result.embedding);
  } catch (error) {
    await recordError({
      severity: 'error',
      source: 'server',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      userId: args.userId,
      context: {
        kind: `${args.table}_embedding_persist_failure`,
        table: args.table,
        rowId: args.rowId,
        tenantId: args.tenantId,
      },
    });
  }
}
