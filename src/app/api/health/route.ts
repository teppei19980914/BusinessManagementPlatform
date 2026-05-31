/**
 * ヘルスチェック / ウォームアップエンドポイント
 *
 * 目的:
 * - Netlify Function のコールドスタート抑制（外部 cron から定期 ping）
 * - DB コネクションの事前確立（pg Pool を温存）
 * - 本番環境での死活監視
 *
 * 設計方針:
 * - 認証不要（外部 cron サービスから匿名で叩けるように publicPaths に追加）
 * - 機密情報を返さない（status / timestamp / db 状態のみ）
 * - 副作用なし（SELECT 1 のみ、書き込み処理なし）
 * - 可能な限り高速に応答（5 秒タイムアウト）
 *
 * ref: docs/developer/performance/20260417/after/次期プログラム/cold-start-and-data-growth-analysis.md §4.1
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { DB_PING_TIMEOUT_MS } from '@/config';

// Node Runtime 必須（Prisma + pg adapter は Edge Runtime 非対応）
export const runtime = 'nodejs';

// キャッシュ禁止（毎回 DB ping を実行する必要がある）
export const dynamic = 'force-dynamic';

// perf/comprehensive-perf-2026-06-01 (D-1):
//   タブ API route (例: /api/projects/[id]/risks) の cold start 連鎖 (1 ページで burst 数 fetch
//   発生時に 2 つの Function instance が cold で 9s 待ち) を観測。
//   /api/health は document route Function を温める用途だが、Prisma の query plan cache は
//   テーブル単位でのみ warm されるため、まだ叩いていない常用テーブルへの初回クエリは
//   Plan 構築でやや遅くなる。warmup 時に主要常用テーブル (Tenant / User / Project / RiskIssue /
//   Retrospective / Knowledge) を LIMIT 0 で touch することで、Plan cache を pre-populate
//   する。データは返さないので副作用なし。
//
//   Burst 時の cold cascade 自体は本 PR の他項目 (E: SessionProvider refetch 無効化 / F: Link
//   prefetch=false / B-1/B-3: タブ lazy import) で burst 数自体を減らすことで間接的に緩和される。
//   D-1 単体ではなく系全体での効果として現れる設計。
export async function GET() {
  const startedAt = Date.now();

  // DB 接続確認（タイムアウト付き）
  const dbStatus = await Promise.race([
    prisma.$queryRaw`SELECT 1`
      .then(() => 'ok' as const)
      .catch(() => 'error' as const),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), DB_PING_TIMEOUT_MS)),
  ]);

  // Prisma の query plan cache pre-warm (data 取得なし、Plan 構築のみ目的)。
  //   - LIMIT 0 で 0 行返却、テーブル schema を Prisma adapter に load させる
  //   - Promise.allSettled で 1 つの失敗 (例: 将来テーブル rename) が全体を倒さないように
  //   - メイン応答時間に影響しないよう dbStatus 確定後に fire-and-forget で実行
  //   - 失敗しても health response 自体は ok を返す (主要 SELECT 1 が通れば DB は生きている判断)
  //   - $queryRaw の tagged template は文字列リテラルからの SQL injection を構造的に防ぐ
  if (dbStatus === 'ok') {
    void Promise.allSettled([
      prisma.$queryRaw`SELECT 1 FROM tenants LIMIT 0`.catch(() => null),
      prisma.$queryRaw`SELECT 1 FROM users LIMIT 0`.catch(() => null),
      prisma.$queryRaw`SELECT 1 FROM projects LIMIT 0`.catch(() => null),
      prisma.$queryRaw`SELECT 1 FROM risks_issues LIMIT 0`.catch(() => null),
      prisma.$queryRaw`SELECT 1 FROM retrospectives LIMIT 0`.catch(() => null),
      prisma.$queryRaw`SELECT 1 FROM knowledges LIMIT 0`.catch(() => null),
    ]);
  }

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
