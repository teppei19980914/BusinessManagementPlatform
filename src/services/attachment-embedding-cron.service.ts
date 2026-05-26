/**
 * Attachment Embedding 背景処理サービス (ADR-0021 §3.3 / 2026-05-26)
 *
 * 役割:
 *   embeddingStatus='pending' の Attachment を batch で処理し、本文抽出 → embedding 生成
 *   → DB 更新を行う。指数 backoff (1min / 5min / 30min) で 3 回までリトライ。
 *
 * フロー:
 *   1. 対象 Attachment を pending 状態かつ retry 待機解除済から fetch (最大 BATCH_SIZE 件)
 *   2. 1 件ずつ:
 *      a. Supabase Storage からダウンロード
 *      b. file-text-extraction でテキスト抽出
 *      c. attachment-embedding.service で embedding 生成 (Voyage + ApiCallLog)
 *      d. 成功 → 'completed' / 失敗 → リトライ or 'failed'
 *   3. 結果サマリを返す
 *
 * 設計判断:
 *   - 1 cron 実行で BATCH_SIZE 件まで処理 (Netlify Function timeout 防止)
 *   - 1 件失敗で他は継続 (= 個別 try/catch)
 *   - per-tenant / global の並行制御は attachment-embedding.service が担う
 *
 * 関連:
 *   - ADR: docs/adr/0021-file-storage-usage-based-billing.md §3
 *   - 単体: src/services/attachment-embedding.service.ts (embed 1 件 + Voyage 呼出)
 *   - text 抽出: src/services/file-text-extraction.service.ts
 *   - cron route: src/app/api/cron/attachment-embedding/route.ts
 */

import { prisma } from '@/lib/db';
import { downloadObject } from '@/lib/supabase-storage';
import { extractText } from '@/services/file-text-extraction.service';
import { embedAttachment } from '@/services/attachment-embedding.service';
import { recordError } from '@/services/error-log.service';

/** 1 cron 実行で処理する最大件数 (= timeout 余裕とスループットのバランス) */
export const ATTACHMENT_EMBEDDING_BATCH_SIZE = 20;

/**
 * 指数 backoff スケジュール (ADR-0021 §3.3)。
 *   retryCount=0 → 即座に再試行可
 *   retryCount=1 → 1 min 後
 *   retryCount=2 → 5 min 後
 *   retryCount>=3 → 'failed' 確定 (= リトライ対象外)
 */
const RETRY_BACKOFF_MS: readonly number[] = [
  0, // 1 回目
  60 * 1000, // 1min
  5 * 60 * 1000, // 5min
];

/**
 * 次回リトライ可能か判定。
 * retryCount=0 (= 未試行) は常に true、それ以外は lastRetryAt + backoff <= now で判定。
 */
export function isReadyForRetry(
  retryCount: number,
  lastRetryAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (retryCount <= 0) return true;
  // retryCount >= MAX (= 3) は既に max リトライ済 → 'failed' 確定で対象外
  if (retryCount >= RETRY_BACKOFF_MS.length) return false;
  const backoff = RETRY_BACKOFF_MS[retryCount] ?? 0;
  if (!lastRetryAt) return true;
  return now.getTime() - lastRetryAt.getTime() >= backoff;
}

export interface EmbeddingCronResult {
  /** 処理を試みた件数 */
  processed: number;
  /** 成功 (= 'completed' に遷移) */
  succeeded: number;
  /** リトライ予定 (= retry < MAX で 'pending' に戻った件数) */
  willRetry: number;
  /** 永続失敗 (= 'failed' 確定) */
  failed: number;
  /** throttle (= 並行上限到達でスキップ) */
  throttled: number;
  /** unsupported (= 抽出対象外、'unsupported' に遷移) */
  unsupported: number;
}

/**
 * Embedding pending Queue を 1 batch 処理する。
 * cron route から呼ばれる。
 */
export async function processAttachmentEmbeddingQueue(
  now: Date = new Date(),
): Promise<EmbeddingCronResult> {
  const result: EmbeddingCronResult = {
    processed: 0,
    succeeded: 0,
    willRetry: 0,
    failed: 0,
    throttled: 0,
    unsupported: 0,
  };

  // 1. 対象 fetch (pending + storageProvider='supabase' + deletedAt=null)
  //    意図的に全テナント横断 (= cron で全テナント対象、tenant 認可は不要)
  const pendingAttachments = await prisma.attachment.findMany({
    where: {
      embeddingStatus: 'pending',
      storageProvider: 'supabase',
      deletedAt: null,
    },
    select: {
      id: true,
      tenantId: true,
      storageObjectKey: true,
      url: true,
      displayName: true,
      embeddingRetryCount: true,
      embeddingLastRetryAt: true,
    },
    orderBy: { createdAt: 'asc' },
    take: ATTACHMENT_EMBEDDING_BATCH_SIZE * 3, // backoff filter で間引くため多めに引く
  });

  for (const a of pendingAttachments) {
    if (result.processed >= ATTACHMENT_EMBEDDING_BATCH_SIZE) break;
    if (!isReadyForRetry(a.embeddingRetryCount, a.embeddingLastRetryAt, now)) continue;

    result.processed += 1;

    // objectKey は storageObjectKey 優先、なければ url (= post-PR-A 仕様で同値)
    const objectKey = a.storageObjectKey ?? a.url;
    if (!objectKey) {
      // データ不整合: storage object key が無い → 'unsupported' 扱いで除外
      await prisma.attachment.update({
        where: { id: a.id },
        data: { embeddingStatus: 'unsupported' },
      });
      result.unsupported += 1;
      continue;
    }

    try {
      // 2a. ダウンロード
      const buffer = await downloadObject(objectKey);

      // 2b. テキスト抽出
      const extraction = await extractText(a.displayName, buffer);
      if (extraction.kind === 'unsupported') {
        await prisma.attachment.update({
          where: { id: a.id },
          data: { embeddingStatus: 'unsupported' },
        });
        result.unsupported += 1;
        continue;
      }
      if (extraction.kind === 'error') {
        // text 抽出失敗もリトライ対象 (PDF パース不能等)
        const updatedRetryCount = a.embeddingRetryCount + 1;
        await prisma.attachment.update({
          where: { id: a.id },
          data: {
            embeddingStatus: updatedRetryCount >= RETRY_BACKOFF_MS.length ? 'failed' : 'pending',
            embeddingRetryCount: updatedRetryCount,
            embeddingLastRetryAt: now,
          },
        });
        if (updatedRetryCount >= RETRY_BACKOFF_MS.length) result.failed += 1;
        else result.willRetry += 1;
        continue;
      }

      // 2c. embedding 生成
      const embedRes = await embedAttachment({
        attachmentId: a.id,
        tenantId: a.tenantId,
        text: extraction.text,
        sha256: extraction.sha256,
      });

      if (embedRes.kind === 'success') {
        result.succeeded += 1;
      } else if (embedRes.kind === 'throttled') {
        result.throttled += 1;
      } else if (embedRes.kind === 'failed_will_retry') {
        result.willRetry += 1;
      } else if (embedRes.kind === 'failed_permanent') {
        result.failed += 1;
      }
    } catch (e) {
      // ダウンロード失敗等の予期せぬエラー: リトライ counter を進める
      try {
        const updatedRetryCount = a.embeddingRetryCount + 1;
        await prisma.attachment.update({
          where: { id: a.id },
          data: {
            embeddingStatus: updatedRetryCount >= RETRY_BACKOFF_MS.length ? 'failed' : 'pending',
            embeddingRetryCount: updatedRetryCount,
            embeddingLastRetryAt: now,
          },
        });
        if (updatedRetryCount >= RETRY_BACKOFF_MS.length) result.failed += 1;
        else result.willRetry += 1;
      } catch {
        // last-resort
      }
      try {
        await recordError({
          severity: 'warn',
          source: 'cron',
          message: '[attachment-embedding-cron] 1 件処理失敗',
          stack: e instanceof Error ? e.stack : undefined,
          context: {
            kind: 'attachment_embedding_cron',
            attachmentId: a.id,
            tenantId: a.tenantId,
            error: e instanceof Error ? e.message : String(e),
          },
        });
      } catch {
        // ignore (recordError 自体が失敗するケース)
      }
    }
  }

  return result;
}
