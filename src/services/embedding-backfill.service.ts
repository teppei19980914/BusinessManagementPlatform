/**
 * 月初 embedding 補完バッチ (縮退モード確定仕様 / 2026-05-14、Memo 追加 / 2026-05-15)
 *
 * 役割:
 *   月跨ぎでテナント月間上限 / 月額予算がリセットされたタイミングで、`content_embedding=NULL`
 *   のまま蓄積した業務エンティティ (Project / Knowledge / RiskIssue / Retrospective / Memo) を
 *   一括で embedding 生成 + DB 永続化する。
 *
 * 起動契機:
 *   Vercel Cron `/api/cron/tenant-monthly-reset` の最終ステップとして呼ばれる
 *   (`runTenantMonthlyReset` 内で resetTenantMonthlyCounters 直後に実行)。
 *   タイミング:
 *     1. snapshot 保存 (前月分の確定値を履歴に書く)
 *     2. counter リセット (currentMonthApiCallCount=0)
 *     3. scheduledPlanChangeAt 適用
 *     4. storage add-on 適用
 *     5. **本処理** = 当月の予算枠を使って NULL を補完 (= 本処理のコストは当月分にカウント)
 *     6. テナント物理削除
 *
 * 設計判断:
 *   - **テナントごとに**処理する: withMeteredLLM は tenantId スコープで rate limit / 予算
 *     チェックするため、テナント単位で呼び出すのが自然。
 *   - **テナントの月間上限を尊重**: Beginner 月 50 回 / Pro/Expert monthlyBudgetCapJpy。
 *     ※ ADR-0019 (2026-05-24): backfill featureUnit (`*-embedding-backfill`) は無料化されたため
 *     Tenant.currentMonthApiCallCount を消費せず、Beginner 上限にも影響しない。残るのは
 *     fair-use-limit (月 10,000 calls/tenant) のみ。上限超過時はその時点で停止する。
 *   - **visibility='draft' は対象外**: 提案エンジン側で除外されるエンティティに対して
 *     embedding 生成 (= Voyage API 課金) を発生させない (PR #358 と整合)。
 *   - **bulk 集約**: `generateAndPersistBatchEmbeddings` を使い、1 業務操作 = 1 ApiCallLog
 *     に集約する (ユーザ視点の請求単位を業務単位に揃える方針と整合)。
 *   - **テーブル単位で処理**: 同一 featureUnit でログを揃えるため、Project / Knowledge /
 *     RiskIssue / Retrospective を別々に処理する。
 *   - **冪等性**: 既に embedding 生成済みのエンティティは候補に含まないため、再実行しても
 *     副作用なし (= cron at-least-once でも安全)。
 *
 * 制限:
 *   - 1 テナント 1 バッチで処理する最大件数は `MAX_BACKFILL_PER_TENANT_PER_TABLE` で抑制
 *     (= MAX_BATCH_SIZE=128 と同値)。1 度に巨大バッチを走らせるとタイムアウトリスクが上がる
 *     ため、月初 cron で当月分の上限まで処理し、超過分は翌月再試行 (= ユーザに見える遅延は
 *     最悪 1 ヶ月、それより以前から積み上がる懸念は実運用にて要観察)。
 *
 * 関連:
 *   - 設計: docs/business/TENANT_AND_BILLING.md §34.14.4
 *   - 設計: docs/design/SUGGESTION_ENGINE.md
 *   - cron entry: src/app/api/cron/tenant-monthly-reset/route.ts
 */

import { prisma } from '@/lib/db';
import {
  generateAndPersistBatchEmbeddings,
  type EmbeddingSearchTable,
} from './embedding.service';
import { composeKnowledgeText } from './knowledge.service';
import { composeProjectText } from './project.service';
import { composeRiskText } from './risk.service';
import { composeRetrospectiveText } from './retrospective.service';
import { composeMemoText } from './memo.service';

/** 1 テナント 1 テーブル当たりの最大補完件数 (Voyage 1 リクエスト推奨上限と整合)。 */
export const MAX_BACKFILL_PER_TENANT_PER_TABLE = 128;

/**
 * 1 テナントあたりの補完結果サマリ。
 */
export interface TenantBackfillResult {
  tenantId: string;
  /** テーブル別の生成成功件数 */
  generated: { [table in EmbeddingSearchTable]?: number };
  /** テーブル別の失敗件数 (上限超過 / API エラー含む) */
  failed: { [table in EmbeddingSearchTable]?: number };
  /** テーブル別のスキップ件数 (text が空など、課金発生せず処理対象外と判定) */
  skipped: { [table in EmbeddingSearchTable]?: number };
}

export interface BackfillSummary {
  /** 処理対象になったテナント数 (= deletedAt IS NULL の総数) */
  tenantCount: number;
  /** テナント別の補完結果 */
  results: TenantBackfillResult[];
}

/**
 * 月初 embedding 補完バッチの本体。
 *
 * @returns 全テナント横断のサマリ
 */
export async function runMonthlyEmbeddingBackfill(): Promise<BackfillSummary> {
  // PR #358 整合: draft は対象外。
  // 補完対象テナントは「deletedAt IS NULL の全テナント」(MANAGEMENT も含む — シードデータの
  // 補完が必要なため)。ただしテナント月間上限を尊重するので、上限超過状態のテナントは
  // withMeteredLLM 側で fail-fast し generated=0 / failed=N となる。
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });

  const results: TenantBackfillResult[] = [];
  for (const tenant of tenants) {
    results.push(await backfillTenant(tenant.id));
  }

  return { tenantCount: tenants.length, results };
}

/**
 * 1 テナント分の補完処理。各テーブルを順次処理する。
 *
 * **export 理由**: 単体テスト + 手動再実行スクリプトから呼び出せるようにするため。
 */
export async function backfillTenant(
  tenantId: string,
): Promise<TenantBackfillResult> {
  const result: TenantBackfillResult = {
    tenantId,
    generated: {},
    failed: {},
    skipped: {},
  };

  for (const table of [
    'projects',
    'knowledges',
    'risks_issues',
    'retrospectives',
    // (2026-05-15) Memo も提案エンジン対象になったため backfill 対象に追加。
    'memos',
  ] as const) {
    const items = await collectNullEmbeddingItems(tenantId, table);
    if (items.length === 0) {
      result.generated[table] = 0;
      result.failed[table] = 0;
      result.skipped[table] = 0;
      continue;
    }

    const res = await generateAndPersistBatchEmbeddings({
      items: items.map((it) => ({ table, rowId: it.rowId, text: it.text })),
      tenantId,
      // userId 省略 = cron / システム実行 (rate limit スキップ)
      featureUnit: `${tableToFeatureUnit(table)}-backfill`,
    });

    result.generated[table] = res.generated;
    result.failed[table] = res.failed;
    result.skipped[table] = items.length - res.generated - res.failed;
  }

  return result;
}

function tableToFeatureUnit(table: EmbeddingSearchTable): string {
  switch (table) {
    case 'projects':
      return 'project-embedding';
    case 'knowledges':
      return 'knowledge-embedding';
    case 'risks_issues':
      return 'risk-issue-embedding';
    case 'retrospectives':
      return 'retrospective-embedding';
    case 'memos':
      return 'memo-embedding';
    default: {
      const _exhaustive: never = table;
      throw new Error(`Invalid table: ${String(_exhaustive)}`);
    }
  }
}

/**
 * テナント内で content_embedding=NULL かつ提案対象になり得る (visibility !== 'draft')
 * エンティティを最大 MAX_BACKFILL_PER_TENANT_PER_TABLE 件取得し、embedding text に整形する。
 */
async function collectNullEmbeddingItems(
  tenantId: string,
  table: EmbeddingSearchTable,
): Promise<Array<{ rowId: string; text: string }>> {
  switch (table) {
    case 'projects': {
      // Project は visibility 列を持たないため全件対象。
      const rows = await prisma.$queryRaw<
        Array<{ id: string; purpose: string; background: string; scope: string }>
      >`
        SELECT id::text AS id, purpose, background, scope
        FROM "projects"
        WHERE tenant_id = ${tenantId}::uuid
          AND deleted_at IS NULL
          AND content_embedding IS NULL
        ORDER BY created_at ASC
        LIMIT ${MAX_BACKFILL_PER_TENANT_PER_TABLE}
      `;
      return rows
        .map((r) => ({
          rowId: r.id,
          text: composeProjectText({
            purpose: r.purpose,
            background: r.background,
            scope: r.scope,
          }),
        }))
        .filter((it) => it.text.trim().length > 0);
    }

    case 'knowledges': {
      const rows = await prisma.$queryRaw<
        Array<{
          id: string;
          title: string;
          background: string;
          content: string;
          result: string;
          conclusion: string | null;
          recommendation: string | null;
        }>
      >`
        SELECT id::text AS id, title, background, content, result, conclusion, recommendation
        FROM "knowledges"
        WHERE tenant_id = ${tenantId}::uuid
          AND deleted_at IS NULL
          AND visibility <> 'draft'
          AND content_embedding IS NULL
        ORDER BY created_at ASC
        LIMIT ${MAX_BACKFILL_PER_TENANT_PER_TABLE}
      `;
      return rows
        .map((r) => ({
          rowId: r.id,
          text: composeKnowledgeText({
            title: r.title,
            background: r.background,
            content: r.content,
            result: r.result,
            conclusion: r.conclusion,
            recommendation: r.recommendation,
          }),
        }))
        .filter((it) => it.text.trim().length > 0);
    }

    case 'risks_issues': {
      // (2026-05-15) RiskIssue は提案エンジンが state='resolved' のみ候補化するため、
      //   backfill 対象も state='resolved' に限定する。state='open' / 'in_progress' /
      //   'monitoring' の embedding は永遠に検索されないため、補完しても無駄。
      //   visibility も 'draft' は提案対象外のため除外 ('public' のみ対象に絞り込み)。
      // feat/risk-issue-4-section (2026-05-26): occurrence (発生事象 / 考えられる事象) を
      //   backfill 対象テキストに加える。既存行は occurrence=NULL のため composeRiskText 内で
      //   空文字扱いされ無視される。新規行のみ embedding に含まれる。
      const rows = await prisma.$queryRaw<
        Array<{
          id: string;
          title: string;
          content: string;
          occurrence: string | null;
          cause: string | null;
          response_policy: string | null;
          response_detail: string | null;
        }>
      >`
        SELECT id::text AS id, title, content, occurrence, cause, response_policy, response_detail
        FROM "risks_issues"
        WHERE tenant_id = ${tenantId}::uuid
          AND deleted_at IS NULL
          AND visibility = 'public'
          AND state = 'resolved'
          AND content_embedding IS NULL
        ORDER BY created_at ASC
        LIMIT ${MAX_BACKFILL_PER_TENANT_PER_TABLE}
      `;
      return rows
        .map((r) => ({
          rowId: r.id,
          text: composeRiskText({
            title: r.title,
            content: r.content,
            occurrence: r.occurrence,
            cause: r.cause,
            responsePolicy: r.response_policy,
            responseDetail: r.response_detail,
          }),
        }))
        .filter((it) => it.text.trim().length > 0);
    }

    case 'retrospectives': {
      const rows = await prisma.$queryRaw<
        Array<{
          id: string;
          plan_summary: string;
          actual_summary: string;
          good_points: string;
          problems: string;
          improvements: string;
          knowledge_to_share: string | null;
        }>
      >`
        SELECT id::text AS id, plan_summary, actual_summary, good_points,
               problems, improvements, knowledge_to_share
        FROM "retrospectives"
        WHERE tenant_id = ${tenantId}::uuid
          AND deleted_at IS NULL
          AND visibility <> 'draft'
          AND content_embedding IS NULL
        ORDER BY created_at ASC
        LIMIT ${MAX_BACKFILL_PER_TENANT_PER_TABLE}
      `;
      return rows
        .map((r) => ({
          rowId: r.id,
          text: composeRetrospectiveText({
            planSummary: r.plan_summary,
            actualSummary: r.actual_summary,
            goodPoints: r.good_points,
            problems: r.problems,
            improvements: r.improvements,
            knowledgeToShare: r.knowledge_to_share,
          }),
        }))
        .filter((it) => it.text.trim().length > 0);
    }

    case 'memos': {
      // (2026-05-15) Memo は visibility='public' (= 全メンバー公開) のみ提案エンジン対象。
      //   visibility='private' (= 自分のみ) は他資産の 'draft' 等価で補完対象外。
      const rows = await prisma.$queryRaw<
        Array<{ id: string; title: string; content: string }>
      >`
        SELECT id::text AS id, title, content
        FROM "memos"
        WHERE tenant_id = ${tenantId}::uuid
          AND deleted_at IS NULL
          AND visibility = 'public'
          AND content_embedding IS NULL
        ORDER BY created_at ASC
        LIMIT ${MAX_BACKFILL_PER_TENANT_PER_TABLE}
      `;
      return rows
        .map((r) => ({
          rowId: r.id,
          text: composeMemoText({ title: r.title, content: r.content }),
        }))
        .filter((it) => it.text.trim().length > 0);
    }

    default: {
      const _exhaustive: never = table;
      throw new Error(`Invalid table: ${String(_exhaustive)}`);
    }
  }
}

/**
 * 1 テナントの NULL 件数を表す型 (UI 表示用)。
 */
export interface NullEmbeddingCounts {
  projects: number;
  knowledges: number;
  risksIssues: number;
  retrospectives: number;
  /** 2026-05-15: Memo 追加 (visibility='public' のみ) */
  memos: number;
  total: number;
}

/**
 * テナントの NULL 件数を集計する (UI 「embedding 未生成 N 件」表示用)。
 *
 * 「自分のみ」(Knowledge/RiskIssue/Retrospective: visibility='draft' / Memo: visibility='private')
 * は提案エンジン対象外のため除外。
 */
export async function countNullEmbeddings(
  tenantId: string,
): Promise<NullEmbeddingCounts> {
  const rows = await prisma.$queryRaw<
    Array<{ table_name: string; count: bigint }>
  >`
    SELECT 'projects' AS table_name, COUNT(*)::bigint AS count
      FROM "projects"
      WHERE tenant_id = ${tenantId}::uuid
        AND deleted_at IS NULL
        AND content_embedding IS NULL
    UNION ALL
    SELECT 'knowledges', COUNT(*)::bigint
      FROM "knowledges"
      WHERE tenant_id = ${tenantId}::uuid
        AND deleted_at IS NULL
        AND visibility <> 'draft'
        AND content_embedding IS NULL
    UNION ALL
    SELECT 'risks_issues', COUNT(*)::bigint
      FROM "risks_issues"
      WHERE tenant_id = ${tenantId}::uuid
        AND deleted_at IS NULL
        AND visibility = 'public'
        AND state = 'resolved'
        AND content_embedding IS NULL
    UNION ALL
    SELECT 'retrospectives', COUNT(*)::bigint
      FROM "retrospectives"
      WHERE tenant_id = ${tenantId}::uuid
        AND deleted_at IS NULL
        AND visibility <> 'draft'
        AND content_embedding IS NULL
    UNION ALL
    SELECT 'memos', COUNT(*)::bigint
      FROM "memos"
      WHERE tenant_id = ${tenantId}::uuid
        AND deleted_at IS NULL
        AND visibility = 'public'
        AND content_embedding IS NULL
  `;

  const map = new Map(rows.map((r) => [r.table_name, Number(r.count)]));
  const projects = map.get('projects') ?? 0;
  const knowledges = map.get('knowledges') ?? 0;
  const risksIssues = map.get('risks_issues') ?? 0;
  const retrospectives = map.get('retrospectives') ?? 0;
  const memos = map.get('memos') ?? 0;
  return {
    projects,
    knowledges,
    risksIssues,
    retrospectives,
    memos,
    total: projects + knowledges + risksIssues + retrospectives + memos,
  };
}
