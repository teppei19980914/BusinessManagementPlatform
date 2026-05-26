/**
 * POST /api/cron/attachment-embedding - Attachment Embedding 背景処理 cron (ADR-0021 §3.3)
 *
 * 外部 cron サービス (cron-job.org 等) から定期的に呼出され、
 * embeddingStatus='pending' の Attachment を batch 処理する。
 * 推奨実行間隔: 5 分〜15 分 (= ユーザ体感「アップロード後すぐ検索可」を担保)。
 *
 * 認可:
 *   Bearer <CRON_SECRET> のみ (= 既存 cron route と同パターン)。
 *
 * 処理:
 *   - 1 回の呼出で最大 ATTACHMENT_EMBEDDING_BATCH_SIZE (= 20) 件を処理
 *   - 指数 backoff: 1min / 5min / 30min (= retry 試行間隔)
 *   - 3 回失敗で embeddingStatus='failed' 確定
 *   - 並行制御は attachment-embedding.service が担う (per-tenant=5 / global=50)
 *
 * 関連:
 *   - ADR: docs/adr/0021-file-storage-usage-based-billing.md §3.3
 *   - service: src/services/attachment-embedding-cron.service.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { processAttachmentEmbeddingQueue } from '@/services/attachment-embedding-cron.service';
import { isCronAuthorized } from '@/lib/cron-auth';
import { withCronExecutionLogging } from '@/lib/cron-execution-log';

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED' } },
      { status: 401 },
    );
  }

  return withCronExecutionLogging('attachment-embedding', req, async () => {
    const result = await processAttachmentEmbeddingQueue();
    return {
      data: {
        source: 'cron',
        processed: result.processed,
        succeeded: result.succeeded,
        willRetry: result.willRetry,
        failed: result.failed,
        throttled: result.throttled,
        unsupported: result.unsupported,
      },
    };
  });
}

export async function GET() {
  return NextResponse.json(
    { error: { code: 'METHOD_NOT_ALLOWED' } },
    { status: 405 },
  );
}
