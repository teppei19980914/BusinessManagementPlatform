/**
 * 添付ファイル Embedding 生成サービス (ADR-0021 §3 / 2026-05-26)
 *
 * 役割:
 *   テキスト抽出済みの本文を Voyage AI に送って 1024 次元 embedding を生成し、
 *   Attachment.contentEmbedding にセット + ApiCallLog 記録する。
 *
 * 課金分類:
 *   featureUnit='attachment-embedding' は **無料** (= isBillableFeatureUnit=false)。
 *   理由: 提案エンジン/チャット精度向上のため運営負担で無料化。
 *         ApiCallLog には記録するが costJpy=0、counter / Stripe queue いずれも更新しない。
 *
 * 並行制御:
 *   - per-tenant 同時 embedding job 上限 = 5 (= MAX_CONCURRENT_EMBEDDING_PER_TENANT)
 *   - global 同時上限 = 50 (= MAX_GLOBAL_EMBEDDING_CONCURRENT、Voyage rate limit 防御)
 *   - 単純な in-memory counter で実装 (Netlify Function は短命のため永続化不要)
 *
 * リトライ:
 *   - 失敗時は Attachment.embeddingRetryCount を +1、embeddingLastRetryAt を now()
 *   - 3 回失敗で embeddingStatus='failed'、それ以前は 'pending' に戻して cron が再試行
 *   - 指数 backoff (1min / 5min / 30min) は cron 側で next-retry 判定
 *
 * 関連:
 *   - テキスト抽出: src/services/file-text-extraction.service.ts
 *   - Voyage 呼出: src/lib/llm/voyage-client.ts voyageEmbed()
 *   - 計測 wrapper: src/lib/llm/metered.ts withMeteredLLM()
 *   - cron: src/services/attachment-embedding-cron.service.ts (P3-embedding-cron)
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { voyageEmbed } from '@/lib/llm/voyage-client';
import { LLM_MODELS } from '@/config/llm';
import {
  EMBEDDING_MAX_RETRY,
  MAX_CONCURRENT_EMBEDDING_PER_TENANT,
  MAX_GLOBAL_EMBEDDING_CONCURRENT,
} from '@/config/file-storage-pricing';

// ================================================================
// in-memory 並行制御 (Netlify Function 短命 = process scope で十分)
// ================================================================
const inFlightPerTenant = new Map<string, number>();
let inFlightGlobal = 0;

/** テスト専用: counter リセット */
export function _resetEmbeddingConcurrencyForTest(): void {
  inFlightPerTenant.clear();
  inFlightGlobal = 0;
}

/** 現在の global in-flight 数 (監視 / debug 用) */
export function getGlobalInFlightEmbedding(): number {
  return inFlightGlobal;
}

function tryAcquireSlot(tenantId: string): boolean {
  const current = inFlightPerTenant.get(tenantId) ?? 0;
  if (current >= MAX_CONCURRENT_EMBEDDING_PER_TENANT) return false;
  if (inFlightGlobal >= MAX_GLOBAL_EMBEDDING_CONCURRENT) return false;
  inFlightPerTenant.set(tenantId, current + 1);
  inFlightGlobal += 1;
  return true;
}

function releaseSlot(tenantId: string): void {
  const current = inFlightPerTenant.get(tenantId) ?? 0;
  if (current <= 1) inFlightPerTenant.delete(tenantId);
  else inFlightPerTenant.set(tenantId, current - 1);
  inFlightGlobal = Math.max(0, inFlightGlobal - 1);
}

// ================================================================
// 公開関数
// ================================================================

export type EmbedAttachmentResult =
  | { kind: 'success'; tokens: number }
  | { kind: 'throttled' } // 並行上限到達 → cron が後で retry
  | { kind: 'failed_will_retry'; error: string; nextRetryCount: number }
  | { kind: 'failed_permanent'; error: string };

/**
 * 1 件の Attachment に対し embedding を生成する。
 *
 * 前提:
 *   - 呼出側で text/sha256 を抽出済み (file-text-extraction.service)
 *   - Attachment.embeddingStatus は 'generating' に既に遷移済 (= 重複実行防止)
 *
 * @returns 結果。throttled の場合は呼出側で status を 'pending' に戻すこと
 */
export async function embedAttachment(args: {
  attachmentId: string;
  tenantId: string;
  text: string;
  sha256: string;
}): Promise<EmbedAttachmentResult> {
  if (!tryAcquireSlot(args.tenantId)) {
    return { kind: 'throttled' };
  }

  const startedAt = Date.now();
  try {
    // featureUnit='attachment-embedding' は FREE — costJpy=0、counter / Stripe queue 不変
    // withMeteredLLM を使うとオーバーヘッドが大きい (rate limit / plan 解決等) ため、
    // 直接 voyageEmbed + ApiCallLog INSERT で記録する (= db-capacity-overage と同方式)
    const result = await voyageEmbed({
      texts: [args.text],
      inputType: 'document',
    });
    const vector = result.embeddings[0];
    if (!vector || vector.length !== 1024) {
      throw new Error(`unexpected embedding length: ${vector?.length}`);
    }

    // contentEmbedding は Unsupported('vector(1024)') のため raw SQL で UPDATE
    // pgvector の配列リテラル '[v1,v2,...]' 形式
    const vectorLiteral = `[${vector.join(',')}]`;
    const latencyMs = Date.now() - startedAt;
    const requestId = randomUUID();
    await prisma.$transaction([
      prisma.$executeRaw`
        UPDATE attachments
           SET content_embedding = ${vectorLiteral}::vector(1024),
               embedding_status = 'completed',
               extracted_text_hash = ${args.sha256},
               embedding_generated_at = NOW()
         WHERE id = ${args.attachmentId}::uuid
      `,
      prisma.apiCallLog.create({
        data: {
          tenantId: args.tenantId,
          userId: null,
          // ADR-0021: 'attachment-embedding' は FREE (= isBillableFeatureUnit=false)
          // 監査用に記録するが costJpy=0、counter / Stripe queue は更新しない
          featureUnit: 'attachment-embedding',
          modelName: LLM_MODELS.EMBEDDING,
          llmInputTokens: null,
          llmOutputTokens: null,
          embeddingTokens: result.totalTokens,
          costJpy: 0,
          latencyMs,
          requestId,
        },
      }),
    ]);

    return { kind: 'success', tokens: result.totalTokens };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // リトライ判定
    const att = await prisma.attachment.findUnique({
      where: { id: args.attachmentId },
      select: { embeddingRetryCount: true },
    });
    const nextCount = (att?.embeddingRetryCount ?? 0) + 1;

    if (nextCount >= EMBEDDING_MAX_RETRY) {
      await prisma.attachment.update({
        where: { id: args.attachmentId },
        data: {
          embeddingStatus: 'failed',
          embeddingRetryCount: nextCount,
          embeddingLastRetryAt: new Date(),
        },
      });
      return { kind: 'failed_permanent', error: msg };
    }

    // 'pending' に戻して cron が次回試行
    await prisma.attachment.update({
      where: { id: args.attachmentId },
      data: {
        embeddingStatus: 'pending',
        embeddingRetryCount: nextCount,
        embeddingLastRetryAt: new Date(),
      },
    });
    return { kind: 'failed_will_retry', error: msg, nextRetryCount: nextCount };
  } finally {
    releaseSlot(args.tenantId);
  }
}
