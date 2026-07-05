/**
 * scripts/backfill-idea-embeddings.ts (v1.5.0)
 *
 * 役割:
 *   PJ内フクロウ機能の追加に伴い、既存のクローズ済み IdeaQaThread /
 *   IdeaWhiteboardSession / IdeaVotingSession の content_embedding を一括生成する。
 *
 * 課金:
 *   featureUnit は '*-embedding-backfill' (ADR-0022 §EMBEDDING_BACKFILL_FEATURE_UNITS)。
 *   withMeteredLLM は cost=0 / counter 不変 / Stripe queue 不投入 で記録する。
 *   本スクリプトは「ユーザ非起動の修復処理」のため全プラン無料 (= 不当請求防止)。
 *   ただし本スクリプトは withMeteredLLM を経由せず、voyageEmbed を直接呼ぶ実装。
 *   ApiCallLog は記録しない (= Voyage 無料枠消費のみ)。
 *
 * 前提:
 *   - DATABASE_URL / VOYAGE_API_KEY が .env または環境変数に設定されていること
 *   - DB への接続が必要 (ローカル DB または本番接続情報を一時設定)
 *
 * 使い方:
 *   pnpm tsx scripts/backfill-idea-embeddings.ts
 *   pnpm tsx scripts/backfill-idea-embeddings.ts --dry-run   # DB 書込なしで対象件数のみ表示
 *
 * 冪等性:
 *   content_embedding IS NULL の行のみを対象とする。再実行しても二重課金しない。
 *
 * 関連:
 *   - 設計: docs/design/IDEA_FEATURES.md
 *   - 課金: src/config/billing-feature-units.ts EMBEDDING_BACKFILL_FEATURE_UNITS
 *   - migration: prisma/migrations/20260629000000_add_idea_embeddings/migration.sql
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { voyageEmbed } from '../src/lib/llm/voyage-client';
import { MAX_INPUT_CHARS } from '../src/services/embedding.service';

const isDryRun = process.argv.includes('--dry-run');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as never);

// ================================================================
// ヘルパー
// ================================================================

async function generateAndPersist(
  table: 'idea_qa_threads' | 'idea_whiteboard_sessions' | 'idea_voting_sessions',
  id: string,
  tenantId: string,
  text: string,
): Promise<'success' | 'skipped' | 'error'> {
  const truncated = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
  if (truncated.trim().length === 0) {
    console.log(`  [SKIP] ${table} ${id} — empty text`);
    return 'skipped';
  }

  if (isDryRun) {
    console.log(`  [DRY-RUN] would embed ${table} ${id} (${truncated.length} chars)`);
    return 'success';
  }

  try {
    const result = await voyageEmbed({ texts: [truncated], inputType: 'document' });
    const embedding = result.embeddings[0];
    if (!embedding || embedding.length !== 1024) {
      console.error(`  [ERROR] ${table} ${id} — invalid embedding length ${embedding?.length}`);
      return 'error';
    }
    const vectorLiteral = `[${embedding.join(',')}]`;
    await prisma.$executeRawUnsafe(
      `UPDATE "${table}" SET "content_embedding" = $1::vector WHERE id = $2::uuid AND tenant_id = $3::uuid`,
      vectorLiteral,
      id,
      tenantId,
    );
    console.log(`  [OK] ${table} ${id}`);
    return 'success';
  } catch (err) {
    console.error(`  [ERROR] ${table} ${id} —`, err instanceof Error ? err.message : String(err));
    return 'error';
  }
}

// ================================================================
// 各テーブルのバックフィル
// ================================================================

async function backfillQaThreads(): Promise<{ success: number; skipped: number; error: number }> {
  const threads = await prisma.ideaQaThread.findMany({
    where: { status: 'closed', deletedAt: null, contentEmbedding: null } as never,
    include: { answers: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`\n[IdeaQaThread] クローズ済み/embedding未生成: ${threads.length} 件`);

  let success = 0; let skipped = 0; let error = 0;
  for (const thread of threads) {
    const parts = [thread.question, ...thread.answers.map((a: { content: string }) => a.content)];
    const text = parts.filter(Boolean).join('\n');
    const result = await generateAndPersist('idea_qa_threads', thread.id, thread.tenantId, text);
    if (result === 'success') success++;
    else if (result === 'skipped') skipped++;
    else error++;
  }
  return { success, skipped, error };
}

async function backfillWhiteboardSessions(): Promise<{ success: number; skipped: number; error: number }> {
  const sessions = await prisma.ideaWhiteboardSession.findMany({
    where: { status: 'closed', deletedAt: null, contentEmbedding: null } as never,
    include: { notes: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`\n[IdeaWhiteboardSession] クローズ済み/embedding未生成: ${sessions.length} 件`);

  let success = 0; let skipped = 0; let error = 0;
  for (const session of sessions) {
    const parts = [session.title, session.description ?? '', ...session.notes.map((n: { content: string }) => n.content)];
    const text = parts.filter(Boolean).join('\n');
    const result = await generateAndPersist('idea_whiteboard_sessions', session.id, session.tenantId, text);
    if (result === 'success') success++;
    else if (result === 'skipped') skipped++;
    else error++;
  }
  return { success, skipped, error };
}

async function backfillVotingSessions(): Promise<{ success: number; skipped: number; error: number }> {
  const sessions = await prisma.ideaVotingSession.findMany({
    where: { status: 'closed', deletedAt: null, contentEmbedding: null } as never,
    include: { options: { orderBy: { displayOrder: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`\n[IdeaVotingSession] クローズ済み/embedding未生成: ${sessions.length} 件`);

  let success = 0; let skipped = 0; let error = 0;
  for (const session of sessions) {
    const optionLabels = session.options.map((o: { label: string }) => o.label).join(' / ');
    const parts = [session.title, session.description ?? '', optionLabels];
    const text = parts.filter(Boolean).join('\n');
    const result = await generateAndPersist('idea_voting_sessions', session.id, session.tenantId, text);
    if (result === 'success') success++;
    else if (result === 'skipped') skipped++;
    else error++;
  }
  return { success, skipped, error };
}

// ================================================================
// メイン
// ================================================================

async function main() {
  console.log(`=== backfill-idea-embeddings (${isDryRun ? 'DRY-RUN' : 'LIVE'}) ===`);

  const qaStats = await backfillQaThreads();
  const wbStats = await backfillWhiteboardSessions();
  const vtStats = await backfillVotingSessions();

  console.log('\n=== 結果サマリー ===');
  console.log(`IdeaQaThread:           OK=${qaStats.success} SKIP=${qaStats.skipped} ERR=${qaStats.error}`);
  console.log(`IdeaWhiteboardSession:  OK=${wbStats.success} SKIP=${wbStats.skipped} ERR=${wbStats.error}`);
  console.log(`IdeaVotingSession:      OK=${vtStats.success} SKIP=${vtStats.skipped} ERR=${vtStats.error}`);
  console.log(`合計: OK=${qaStats.success + wbStats.success + vtStats.success} SKIP=${qaStats.skipped + wbStats.skipped + vtStats.skipped} ERR=${qaStats.error + wbStats.error + vtStats.error}`);

  if (isDryRun) console.log('\n(DRY-RUN: DB 書込なし)');
}

main()
  .catch((err) => { console.error('Fatal:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
