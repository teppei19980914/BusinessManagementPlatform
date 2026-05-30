/**
 * scripts/generate-faq-embeddings.ts (ADR-0028 / 2026-05-30)
 *
 * 役割:
 *   `src/config/faq-content.ts` (FAQ_ENTRIES) と `src/config/guide-content.ts`
 *   (GUIDE_STEPS) の全エントリについて、Voyage AI で embedding を生成し
 *   `faq_embeddings` / `guide_embeddings` テーブルに upsert する。
 *   削除されたエントリは DB からも削除する (add/update/delete を 1 経路で扱う)。
 *
 * ★ たすきば存続の生命線 ★ ([[feedback_ui_completion_is_default_scope]] の
 *   ヘルプチャット運用は本 script が DB を最新化していることが前提)
 *   FAQ/Guide を `src/config/*` で更新したら **必ず deploy 後** 本 script を
 *   実行すること。詳細 SOP は docs/operations/DEPLOYMENT.md / developer-guide §7。
 *
 * 同期判定:
 *   - composeFaqContentText / composeGuideContentText で生成したテキストの
 *     SHA-256 (= computeContentHash) を `faq_embeddings.content_hash` と比較
 *   - hash 一致 → 不変、skip (Voyage API 呼出も skip = コスト 0)
 *   - hash 相違 or 行不在 → voyageEmbed → upsert
 *   - config 不在 + DB 存在 → DELETE (= 削除されたエントリの cleanup)
 *
 * 使い方:
 *   pnpm generate:faq-embeddings              # 実行 (Voyage API 呼出 + DB 書込)
 *   pnpm generate:faq-embeddings --dry-run    # 実行計画のみ表示 (Voyage API 不要)
 *
 * 環境変数:
 *   VOYAGE_API_KEY: Voyage AI API キー (.env または .env.local)
 *   DATABASE_URL: 対象 DB の接続文字列 (.env.local で本番接続も可)
 *
 * 設計判断:
 *   - **service と同じ compose 関数を共有**: src/services/help-search.service.ts の
 *     composeFaqContentText / composeGuideContentText / computeContentHash を
 *     import して使う。重複定義による hash drift = 全件再生成の罠を防ぐ
 *     ([[feedback_reuse_existing_design_first]])。
 *   - **voyageEmbed 直叩き**: scripts/ ディレクトリは check-llm-billing-bypass の
 *     SKIP_DIRS に含まれるため allowlist 不要。scripts は tenant に紐づかない
 *     ため withMeteredLLM のテナント単位 counter / ApiCallLog 経路は意味を持たない。
 *     Voyage トークン利用は scripts/generate-seed-embeddings.ts と同じ独立経路。
 *   - **冪等**: 同じ config 状態で何度実行しても DB 状態は一致 (hash 不変なら skip)。
 *
 * 関連:
 *   - docs/adr/0028-help-chat-rag-migration.md
 *   - src/services/help-search.service.ts (compose / computeContentHash の真値)
 *   - scripts/check-faq-embeddings-sync.ts (本 script の "DB 状態は config と一致" を
 *     CI で検証する側。本 script 実行漏れの検出)
 *   - docs/operations/DEPLOYMENT.md §FAQ/Guide 更新時の手順
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

import { voyageEmbed } from '../src/lib/llm/voyage-client';
import { EMBEDDING_DIMENSIONS } from '../src/config/llm';
import { FAQ_ENTRIES, type FaqEntry } from '../src/config/faq-content';
import { GUIDE_STEPS, type GuideStep } from '../src/config/guide-content';
import {
  composeFaqContentText,
  composeGuideContentText,
  computeContentHash,
  mapVisibleToFlags,
} from '../src/services/help-search.service';

// ================================================================
// 型 / 共通
// ================================================================

interface SyncStats {
  table: 'faq_embeddings' | 'guide_embeddings';
  added: number;
  updated: number;
  unchanged: number;
  deleted: number;
  failed: number;
}

function emptyStats(table: SyncStats['table']): SyncStats {
  return { table, added: 0, updated: 0, unchanged: 0, deleted: 0, failed: 0 };
}

function checkEnv(dryRun: boolean): void {
  if (!dryRun && (!process.env.VOYAGE_API_KEY || process.env.VOYAGE_API_KEY.trim() === '')) {
    console.error('❌ VOYAGE_API_KEY 環境変数が未設定です。');
    console.error('   .env または .env.local に設定してから再実行してください。');
    console.error('   --dry-run で実行計画のみ確認したい場合は VOYAGE_API_KEY 不要です。');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
    console.error('❌ DATABASE_URL 環境変数が未設定です。');
    process.exit(1);
  }
}

async function embedOne(text: string, label: string): Promise<number[] | null> {
  try {
    const result = await voyageEmbed({ texts: [text], inputType: 'document' });
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

function vectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`;
}

// ================================================================
// FAQ 同期
// ================================================================

interface FaqRow {
  id: string;
  entry_id: string;
  content_hash: string;
}

async function syncFaqTable(
  prisma: PrismaClient,
  dryRun: boolean,
): Promise<SyncStats> {
  const stats = emptyStats('faq_embeddings');
  console.log(`📚 faq_embeddings 同期 (${FAQ_ENTRIES.length} 件 in config)`);

  const existing = await prisma.$queryRaw<FaqRow[]>`
    SELECT id::text AS id, entry_id, content_hash FROM "faq_embeddings"
  `;
  const existingByEntryId = new Map(existing.map((r) => [r.entry_id, r]));
  const configEntryIds = new Set(FAQ_ENTRIES.map((e) => e.id));

  for (const entry of FAQ_ENTRIES) {
    const text = composeFaqContentText(entry);
    const hash = computeContentHash(text);
    const flags = mapVisibleToFlags(entry.visibleTo);
    const current = existingByEntryId.get(entry.id);

    if (current && current.content_hash === hash) {
      stats.unchanged++;
      continue;
    }

    const action = current ? 'update' : 'add';
    console.log(`   ${action === 'add' ? '➕' : '🔄'} ${entry.id} (${action})`);

    if (dryRun) {
      if (action === 'add') stats.added++;
      else stats.updated++;
      continue;
    }

    const embedding = await embedOne(text, `faq:${entry.id}`);
    if (!embedding) {
      stats.failed++;
      continue;
    }

    const vecText = vectorLiteral(embedding);
    try {
      await prisma.$executeRaw`
        INSERT INTO "faq_embeddings" (
          "entry_id", "content_hash", "content_snapshot", "content_embedding",
          "requires_admin", "requires_project_pm", "category", "generated_at"
        ) VALUES (
          ${entry.id}, ${hash}, ${text}, ${vecText}::vector,
          ${flags.requiresAdmin}, ${flags.requiresProjectPm}, ${entry.category}, NOW()
        )
        ON CONFLICT ("entry_id") DO UPDATE SET
          "content_hash" = EXCLUDED."content_hash",
          "content_snapshot" = EXCLUDED."content_snapshot",
          "content_embedding" = EXCLUDED."content_embedding",
          "requires_admin" = EXCLUDED."requires_admin",
          "requires_project_pm" = EXCLUDED."requires_project_pm",
          "category" = EXCLUDED."category",
          "generated_at" = EXCLUDED."generated_at",
          "updated_at" = NOW()
      `;
      if (action === 'add') stats.added++;
      else stats.updated++;
    } catch (err) {
      console.error(`   ❌ upsert 失敗: ${entry.id} → ${err instanceof Error ? err.message : String(err)}`);
      stats.failed++;
    }
  }

  // config から削除された entry を DB からも削除
  for (const row of existing) {
    if (!configEntryIds.has(row.entry_id)) {
      console.log(`   🗑  ${row.entry_id} (delete = config から削除済)`);
      if (!dryRun) {
        try {
          await prisma.$executeRaw`
            DELETE FROM "faq_embeddings" WHERE entry_id = ${row.entry_id}
          `;
        } catch (err) {
          console.error(`   ❌ delete 失敗: ${row.entry_id} → ${err instanceof Error ? err.message : String(err)}`);
          stats.failed++;
          continue;
        }
      }
      stats.deleted++;
    }
  }

  return stats;
}

// ================================================================
// Guide 同期
// ================================================================

interface GuideRow {
  id: string;
  entry_id: string;
  content_hash: string;
}

async function syncGuideTable(
  prisma: PrismaClient,
  dryRun: boolean,
): Promise<SyncStats> {
  const stats = emptyStats('guide_embeddings');
  console.log(`📖 guide_embeddings 同期 (${GUIDE_STEPS.length} 件 in config)`);

  const existing = await prisma.$queryRaw<GuideRow[]>`
    SELECT id::text AS id, entry_id, content_hash FROM "guide_embeddings"
  `;
  const existingByEntryId = new Map(existing.map((r) => [r.entry_id, r]));
  const configEntryIds = new Set(GUIDE_STEPS.map((s) => s.id));

  // ステップ順序の付与 (GUIDE_STEPS 配列の index を step_order として使用)
  const stepOrderById = new Map<string, number>(
    GUIDE_STEPS.map((s, idx) => [s.id, idx]),
  );

  for (const step of GUIDE_STEPS) {
    const text = composeGuideContentText(step);
    const hash = computeContentHash(text);
    const flags = mapVisibleToFlags(step.visibleTo);
    const stepOrder = stepOrderById.get(step.id)!;
    const current = existingByEntryId.get(step.id);

    if (current && current.content_hash === hash) {
      stats.unchanged++;
      continue;
    }

    const action = current ? 'update' : 'add';
    console.log(`   ${action === 'add' ? '➕' : '🔄'} ${step.id} (${action})`);

    if (dryRun) {
      if (action === 'add') stats.added++;
      else stats.updated++;
      continue;
    }

    const embedding = await embedOne(text, `guide:${step.id}`);
    if (!embedding) {
      stats.failed++;
      continue;
    }

    const vecText = vectorLiteral(embedding);
    try {
      await prisma.$executeRaw`
        INSERT INTO "guide_embeddings" (
          "entry_id", "content_hash", "content_snapshot", "content_embedding",
          "requires_admin", "requires_project_pm", "step_order", "generated_at"
        ) VALUES (
          ${step.id}, ${hash}, ${text}, ${vecText}::vector,
          ${flags.requiresAdmin}, ${flags.requiresProjectPm}, ${stepOrder}, NOW()
        )
        ON CONFLICT ("entry_id") DO UPDATE SET
          "content_hash" = EXCLUDED."content_hash",
          "content_snapshot" = EXCLUDED."content_snapshot",
          "content_embedding" = EXCLUDED."content_embedding",
          "requires_admin" = EXCLUDED."requires_admin",
          "requires_project_pm" = EXCLUDED."requires_project_pm",
          "step_order" = EXCLUDED."step_order",
          "generated_at" = EXCLUDED."generated_at",
          "updated_at" = NOW()
      `;
      if (action === 'add') stats.added++;
      else stats.updated++;
    } catch (err) {
      console.error(`   ❌ upsert 失敗: ${step.id} → ${err instanceof Error ? err.message : String(err)}`);
      stats.failed++;
    }
  }

  for (const row of existing) {
    if (!configEntryIds.has(row.entry_id)) {
      console.log(`   🗑  ${row.entry_id} (delete = config から削除済)`);
      if (!dryRun) {
        try {
          await prisma.$executeRaw`
            DELETE FROM "guide_embeddings" WHERE entry_id = ${row.entry_id}
          `;
        } catch (err) {
          console.error(`   ❌ delete 失敗: ${row.entry_id} → ${err instanceof Error ? err.message : String(err)}`);
          stats.failed++;
          continue;
        }
      }
      stats.deleted++;
    }
  }

  return stats;
}

// ================================================================
// CLI エントリポイント
// ================================================================

function printSummary(stats: SyncStats): void {
  const total = stats.added + stats.updated + stats.unchanged + stats.deleted + stats.failed;
  console.log(
    `   📊 ${stats.table}: ` +
      `+${stats.added} 追加 / ~${stats.updated} 更新 / =${stats.unchanged} 不変 / ` +
      `-${stats.deleted} 削除 / ❌${stats.failed} 失敗 (total ${total})`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  checkEnv(dryRun);

  console.log(`🦉 generate-faq-embeddings ${dryRun ? '(dry-run)' : ''}`);
  console.log('');

  const target = process.env.DATABASE_URL?.match(/@([^/?]+)/)?.[1] ?? '(URL 解析不可)';
  console.log(`   DB target: ${target}`);
  if (!dryRun && !target.startsWith('localhost') && !target.includes('127.0.0.1')) {
    console.log('⚠ リモート DB を対象としています。間違いなければ 5 秒以内に Ctrl+C で中断可能。');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  console.log('');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const faqStats = await syncFaqTable(prisma, dryRun);
    console.log('');
    const guideStats = await syncGuideTable(prisma, dryRun);
    console.log('');
    console.log('✅ 同期完了');
    printSummary(faqStats);
    printSummary(guideStats);

    const totalFailed = faqStats.failed + guideStats.failed;
    if (totalFailed > 0) {
      console.error(`❌ ${totalFailed} 件失敗があります。再実行で続きから処理されます (冪等)。`);
      process.exit(1);
    }
    if (dryRun) {
      const totalPending = faqStats.added + faqStats.updated + faqStats.deleted +
        guideStats.added + guideStats.updated + guideStats.deleted;
      if (totalPending > 0) {
        console.log('');
        console.log(`ℹ dry-run: ${totalPending} 件の変更が pending です。`);
        console.log('   実際に DB を更新するには --dry-run を外して再実行してください。');
      } else {
        console.log('');
        console.log('✨ DB は config と完全同期しています (変更なし)。');
      }
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

// テスト用に内部関数を export
// (本 file 外からの import は scripts/__tests__/generate-faq-embeddings.test.ts のみ想定)
export const __testing = {
  syncFaqTable,
  syncGuideTable,
  emptyStats,
  vectorLiteral,
};

// 型 re-export (test 側で参照)
export type { FaqEntry, GuideStep, SyncStats };
