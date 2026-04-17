/**
 * ヘルスチェック / ウォームアップエンドポイント
 *
 * 目的:
 * - Vercel Serverless Function のコールドスタート抑制（外部 cron から定期 ping）
 * - DB コネクションの事前確立（pg Pool を温存）
 * - 本番環境での死活監視
 *
 * 設計方針:
 * - 認証不要（外部 cron サービスから匿名で叩けるように publicPaths に追加）
 * - 機密情報を返さない（status / timestamp / db 状態のみ）
 * - 副作用なし（SELECT 1 のみ、書き込み処理なし）
 * - 可能な限り高速に応答（5 秒タイムアウト）
 *
 * ref: docs/performance/20260417/after/cold-start-and-data-growth-analysis.md §4.1
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// Node Runtime 必須（Prisma + pg adapter は Edge Runtime 非対応）
export const runtime = 'nodejs';

// キャッシュ禁止（毎回 DB ping を実行する必要がある）
export const dynamic = 'force-dynamic';

// タイムアウト: 5 秒を超えたら DB 側に異常と判断
const DB_PING_TIMEOUT_MS = 5_000;

export async function GET() {
  const startedAt = Date.now();

  // DB 接続確認（タイムアウト付き）
  const dbStatus = await Promise.race([
    prisma.$queryRaw`SELECT 1`
      .then(() => 'ok' as const)
      .catch(() => 'error' as const),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), DB_PING_TIMEOUT_MS)),
  ]);

  const responseTimeMs = Date.now() - startedAt;
  const httpStatus = dbStatus === 'ok' ? 200 : 503;

  return NextResponse.json(
    {
      status: dbStatus === 'ok' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      db: dbStatus,
      responseTimeMs,
    },
    { status: httpStatus },
  );
}
