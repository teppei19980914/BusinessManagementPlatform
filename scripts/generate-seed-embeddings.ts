/**
 * scripts/generate-seed-embeddings.ts (PR-X5 / 5-7)
 *
 * 役割:
 *   1. seed mode (default): SEED_KNOWLEDGE / SAMPLE_PROJECTS / SAMPLE_ISSUES /
 *      SAMPLE_RETROSPECTIVES の text を compose → Voyage API 呼出 → 事前生成 embedding を
 *      prisma/seed-suggestion-embeddings.json に保存。
 *
 *   2. backfill mode (--backfill-existing): DB の content_embedding=NULL の
 *      Knowledge / RiskIssue / Retrospective / Project を走査し、Voyage API で
 *      embedding を生成 → DB へ直接書込。
 *
 * 前提:
 *   - VOYAGE_API_KEY が .env または .env.local に設定されていること
 *   - 開発者環境で 1 回実行する想定 (本番 DB に対して --backfill-existing を実行する場合は
 *     .env.local に本番接続情報を一時設定すること)
 *
 * 使い方:
 *   pnpm seed:generate-embeddings                      # JSON 生成 (シードコンテンツ)
 *   pnpm seed:generate-embeddings --backfill-existing  # 本番 DB の既存データに embedding 生成
 *
 * デザインノート:
 *   - 既存 service の compose 関数 (composeKnowledgeText / composeRiskText / composeRetrospectiveText
 *     / composeProjectText) を再利用。これにより新規データ作成時と backfill で
 *     embedding 対象 text が一致 → 同じベクトル空間に揃う (= 検索精度の一貫性を保証)。
 *   - voyageEmbed は 1 リクエストにつき複数 text を受け付けるが、本 script では
 *     **可読性優先で 1 件ずつ呼出**。seed 規模 (~50 件) では性能ボトルネックではないため、
 *     失敗時のリトライや進捗ログを入れやすい単件呼出を採用。
 *   - 失敗 (rate_limited / network) 時は当該 entry をスキップして処理継続。
 *     スクリプトは冪等のため再実行で残った行を埋められる。
 *
 * 関連:
 *   - 計画: docs/archive/roadmap/V1_FINAL_TASKS.md PR-X5 5-7
 *   - 出力 JSON: prisma/seed-suggestion-embeddings.json
 *   - DB 書込 helper: src/services/embedding.service.ts (persistEmbedding)
 */

import 'dotenv/config';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

import { voyageEmbed } from '../src/lib/llm/voyage-client';
import { EMBEDDING_DIMENSIONS } from '../src/config/llm';
import { composeKnowledgeText } from '../src/services/knowledge.service';
import { composeRiskText } from '../src/services/risk.service';
import { composeRetrospectiveText } from '../src/services/retrospective.service';
import { composeProjectText } from '../src/services/project.service';
import { persistEmbedding } from '../src/services/embedding.service';

import {
  SEED_KNOWLEDGE,
  SAMPLE_PROJECTS,
  SAMPLE_ISSUES,
  SAMPLE_RETROSPECTIVES,
  knowledgeKey,
  issueKey,
  retroKey,
  sampleProjectKey,
} from '../prisma/seed-suggestion';

// ================================================================
// 型定義
// ================================================================

interface SeedEmbeddingsJsonOut {
  $schema?: string;
  _meta: {
    description: string;
    generator: string;
    model: string;
    dimensions: number;
    lastGeneratedAt: string;
    lastGeneratedCommitSha: string | null;
  };
  knowledges: Record<string, number[]>;
  issues: Record<string, number[]>;
  retrospectives: Record<string, number[]>;
  projects: Record<string, number[]>;
}

const SEED_EMBEDDINGS_PATH = join(__dirname, '..', 'prisma', 'seed-suggestion-embeddings.json');

// ================================================================
// helpers
// ================================================================

function checkEnv(): void {
  if (!process.env.VOYAGE_API_KEY || process.env.VOYAGE_API_KEY.trim() === '') {
    console.error('❌ VOYAGE_API_KEY 環境変数が未設定です。');
    console.error('   .env または .env.local に設定してから再実行してください。');
    console.error('');
    console.error('   例 (.env.local):');
    console.error('     VOYAGE_API_KEY=pa-xxxxxxxxxxxxxxxxxx');
    process.exit(1);
  }
}

async function embedOne(text: string, label: string): Promise<number[] | null> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    console.warn(`   ⚠ 空 text のためスキップ: ${label}`);
    return null;
  }
  try {
    const result = await voyageEmbed({ texts: [trimmed], inputType: 'document' });
    const vec = result.embeddings[0];
    if (!vec || vec.length !== EMBEDDING_DIMENSIONS) {
      console.error(`   ❌ embedding 寸法異常: ${label} (got ${vec?.length})`);
      return null;
    }
    return vec;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`   ❌ Voyage API エラー: ${label} → ${message}`);
    return null;
  }
}

function loadExistingJson(): SeedEmbeddingsJsonOut | null {
  try {
    const raw = readFileSync(SEED_EMBEDDINGS_PATH, 'utf-8');
    return JSON.parse(raw) as SeedEmbeddingsJsonOut;
  } catch {
    return null;
  }
}

// ================================================================
// seed mode: シードコンテンツの embedding を JSON に生成
// ================================================================

async function generateSeedEmbeddings(): Promise<void> {
  console.log('🌱 seed mode: SEED_KNOWLEDGE / SAMPLE_PROJECTS / SAMPLE_ISSUES / SAMPLE_RETROSPECTIVES の embedding 生成');
  console.log('');

  // 既存 JSON があれば差分追記する (再生成漏れ防止 + コスト最小化)
  const existing = loadExistingJson();
  const out: SeedEmbeddingsJsonOut = {
    $schema: existing?.$schema,
    _meta: {
      description:
        'PR-X5 で導入された seed データ (Knowledge / Issue / Retrospective / Project) の事前生成 embedding。',
      generator: 'scripts/generate-seed-embeddings.ts',
      model: 'voyage-4-lite',
      dimensions: EMBEDDING_DIMENSIONS,
      lastGeneratedAt: new Date().toISOString(),
      lastGeneratedCommitSha: process.env.GIT_COMMIT_SHA ?? null,
    },
    knowledges: { ...(existing?.knowledges ?? {}) },
    issues: { ...(existing?.issues ?? {}) },
    retrospectives: { ...(existing?.retrospectives ?? {}) },
    projects: { ...(existing?.projects ?? {}) },
  };

  // ---- Knowledge ----
  console.log(`📚 SEED_KNOWLEDGE: ${SEED_KNOWLEDGE.length} 件処理中`);
  let added = 0;
  let reused = 0;
  for (const k of SEED_KNOWLEDGE) {
    const key = knowledgeKey(k);
    if (out.knowledges[key]) {
      reused++;
      continue;
    }
    const text = composeKnowledgeText({
      title: k.title,
      background: k.background,
      content: k.content,
      result: k.result,
      conclusion: k.conclusion,
      recommendation: k.recommendation,
    });
    const vec = await embedOne(text, `knowledge:${k.title}`);
    if (vec) {
      out.knowledges[key] = vec;
      added++;
    }
  }
  console.log(`   ✅ ${added} 件 新規生成 / ${reused} 件 既存再利用`);
  console.log('');

  // ---- Project (sample) ----
  console.log(`🏗  SAMPLE_PROJECTS: ${SAMPLE_PROJECTS.length} 件処理中`);
  added = 0;
  reused = 0;
  for (const p of SAMPLE_PROJECTS) {
    const key = sampleProjectKey(p);
    if (out.projects[key]) {
      reused++;
      continue;
    }
    const text = composeProjectText({
      purpose: p.purpose,
      background: p.background,
      scope: p.scope,
    });
    const vec = await embedOne(text, `project:${p.name}`);
    if (vec) {
      out.projects[key] = vec;
      added++;
    }
  }
  console.log(`   ✅ ${added} 件 新規生成 / ${reused} 件 既存再利用`);
  console.log('');

  // ---- Issue (sample) ----
  console.log(`⚠  SAMPLE_ISSUES: ${SAMPLE_ISSUES.length} 件処理中`);
  added = 0;
  reused = 0;
  for (const i of SAMPLE_ISSUES) {
    const key = issueKey(i);
    if (out.issues[key]) {
      reused++;
      continue;
    }
    const text = composeRiskText({
      title: i.title,
      content: i.content,
      cause: i.cause,
      responsePolicy: i.responsePolicy,
      responseDetail: i.responseDetail,
    });
    const vec = await embedOne(text, `issue:${i.parentProjectName}/${i.title}`);
    if (vec) {
      out.issues[key] = vec;
      added++;
    }
  }
  console.log(`   ✅ ${added} 件 新規生成 / ${reused} 件 既存再利用`);
  console.log('');

  // ---- Retrospective (sample) ----
  console.log(`🔁 SAMPLE_RETROSPECTIVES: ${SAMPLE_RETROSPECTIVES.length} 件処理中`);
  added = 0;
  reused = 0;
  for (const r of SAMPLE_RETROSPECTIVES) {
    const key = retroKey(r);
    if (out.retrospectives[key]) {
      reused++;
      continue;
    }
    const text = composeRetrospectiveText({
      planSummary: r.planSummary,
      actualSummary: r.actualSummary,
      goodPoints: r.goodPoints,
      problems: r.problems,
      improvements: r.improvements,
      knowledgeToShare: r.knowledgeToShare,
    });
    const vec = await embedOne(text, `retro:${r.parentProjectName}/${r.conductedDate}`);
    if (vec) {
      out.retrospectives[key] = vec;
      added++;
    }
  }
  console.log(`   ✅ ${added} 件 新規生成 / ${reused} 件 既存再利用`);
  console.log('');

  // ---- 書込 ----
  writeFileSync(SEED_EMBEDDINGS_PATH, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  console.log(`💾 ${SEED_EMBEDDINGS_PATH} に保存しました`);
  console.log('');
  console.log('次のステップ:');
  console.log('  1. git add prisma/seed-suggestion-embeddings.json');
  console.log('  2. git commit + PR 作成');
  console.log('  3. デプロイ後の seed 投入で各 entity に embedding が付く');
}

// ================================================================
// backfill mode: 本番 DB の既存データに embedding を後付け生成
// ================================================================

async function backfillExistingEmbeddings(): Promise<void> {
  console.log('🔧 backfill mode: 本番 DB の content_embedding=NULL の行に embedding を生成');
  console.log('');
  console.log('⚠ この操作は本番 DB に書込を行います。実行前に DB target を確認してください:');
  const dbUrl = process.env.DATABASE_URL ?? '(未設定)';
  const target = dbUrl.match(/@([^/?]+)/)?.[1] ?? '(URL 解析不可)';
  console.log(`   DB target: ${target}`);
  console.log('');

  if (target.startsWith('localhost') || target.includes('127.0.0.1')) {
    console.log('ℹ ローカル DB を対象としています。');
  } else {
    console.log('⚠ リモート DB を対象としています。間違いなければ 5 秒以内に Ctrl+C で中断可能。');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  console.log('');

  const pool = new Pool({ connectionString: dbUrl });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    let totalProcessed = 0;
    let totalSucceeded = 0;
    let totalFailed = 0;

    // Knowledge
    {
      const rows = await prisma.$queryRaw<
        Array<{
          id: string;
          tenant_id: string;
          title: string;
          background: string;
          content: string;
          result: string;
          conclusion: string | null;
          recommendation: string | null;
        }>
      >`
        SELECT id::text AS id, tenant_id::text AS tenant_id, title, background, content, result, conclusion, recommendation
        FROM "knowledges"
        WHERE "content_embedding" IS NULL AND "deleted_at" IS NULL
      `;
      console.log(`📚 knowledges: ${rows.length} 件 backfill 対象`);
      for (const r of rows) {
        totalProcessed++;
        const text = composeKnowledgeText({
          title: r.title,
          background: r.background,
          content: r.content,
          result: r.result,
          conclusion: r.conclusion,
          recommendation: r.recommendation,
        });
        const vec = await embedOne(text, `knowledge:${r.title}`);
        if (vec) {
          await persistEmbedding('knowledges', r.id, r.tenant_id, vec);
          totalSucceeded++;
        } else {
          totalFailed++;
        }
      }
    }

    // RiskIssue
    {
      const rows = await prisma.$queryRaw<
        Array<{
          id: string;
          tenant_id: string;
          title: string;
          content: string;
          cause: string | null;
          response_policy: string | null;
          response_detail: string | null;
        }>
      >`
        SELECT id::text AS id, tenant_id::text AS tenant_id, title, content, cause, response_policy, response_detail
        FROM "risks_issues"
        WHERE "content_embedding" IS NULL AND "deleted_at" IS NULL
      `;
      console.log(`⚠  risks_issues: ${rows.length} 件 backfill 対象`);
      for (const r of rows) {
        totalProcessed++;
        const text = composeRiskText({
          title: r.title,
          content: r.content,
          cause: r.cause,
          responsePolicy: r.response_policy,
          responseDetail: r.response_detail,
        });
        const vec = await embedOne(text, `risk_issue:${r.title}`);
        if (vec) {
          await persistEmbedding('risks_issues', r.id, r.tenant_id, vec);
          totalSucceeded++;
        } else {
          totalFailed++;
        }
      }
    }

    // Retrospective
    {
      const rows = await prisma.$queryRaw<
        Array<{
          id: string;
          tenant_id: string;
          plan_summary: string;
          actual_summary: string;
          good_points: string;
          problems: string;
          improvements: string;
          knowledge_to_share: string | null;
        }>
      >`
        SELECT id::text AS id, tenant_id::text AS tenant_id, plan_summary, actual_summary, good_points, problems, improvements, knowledge_to_share
        FROM "retrospectives"
        WHERE "content_embedding" IS NULL AND "deleted_at" IS NULL
      `;
      console.log(`🔁 retrospectives: ${rows.length} 件 backfill 対象`);
      for (const r of rows) {
        totalProcessed++;
        const text = composeRetrospectiveText({
          planSummary: r.plan_summary,
          actualSummary: r.actual_summary,
          goodPoints: r.good_points,
          problems: r.problems,
          improvements: r.improvements,
          knowledgeToShare: r.knowledge_to_share,
        });
        const vec = await embedOne(text, `retro:${r.id}`);
        if (vec) {
          await persistEmbedding('retrospectives', r.id, r.tenant_id, vec);
          totalSucceeded++;
        } else {
          totalFailed++;
        }
      }
    }

    // Project
    {
      const rows = await prisma.$queryRaw<
        Array<{
          id: string;
          tenant_id: string;
          purpose: string;
          background: string;
          scope: string;
        }>
      >`
        SELECT id::text AS id, tenant_id::text AS tenant_id, purpose, background, scope
        FROM "projects"
        WHERE "content_embedding" IS NULL AND "deleted_at" IS NULL
      `;
      console.log(`🏗  projects: ${rows.length} 件 backfill 対象`);
      for (const r of rows) {
        totalProcessed++;
        const text = composeProjectText({
          purpose: r.purpose,
          background: r.background,
          scope: r.scope,
        });
        const vec = await embedOne(text, `project:${r.id}`);
        if (vec) {
          await persistEmbedding('projects', r.id, r.tenant_id, vec);
          totalSucceeded++;
        } else {
          totalFailed++;
        }
      }
    }

    console.log('');
    console.log(`✅ backfill 完了: ${totalSucceeded} 件成功 / ${totalFailed} 件失敗 / ${totalProcessed} 件処理`);
    if (totalFailed > 0) {
      console.log('ℹ 失敗分は再実行で続きから処理されます (冪等)');
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

// ================================================================
// CLI エントリポイント
// ================================================================

async function main(): Promise<void> {
  checkEnv();
  const args = process.argv.slice(2);
  const isBackfill = args.includes('--backfill-existing');

  if (isBackfill) {
    await backfillExistingEmbeddings();
  } else {
    await generateSeedEmbeddings();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
