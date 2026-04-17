/**
 * Next.js Instrumentation Hook
 *
 * サーバ起動時に 1 度だけ実行される。コールドスタート時の初回リクエストで
 * DB コネクション確立にかかる時間（TLS ネゴシエーション等）を前倒しする。
 *
 * 効果: 初回リクエストの TTFB を 50-150 ms 短縮（想定）
 * ref: docs/performance/20260417/after/cold-start-and-data-growth-analysis.md §4.1
 *
 * 公式ドキュメント:
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Edge Runtime では Prisma + pg adapter が動作しないため Node Runtime のみで実行
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { prisma } = await import('@/lib/db');
    try {
      await prisma.$connect();
    } catch (error) {
      // 起動時エラーで全リクエストを落とさない。ログのみ残し、初回リクエスト時に再試行させる
      console.error('[instrumentation] prisma.$connect() failed at startup:', error);
    }
  }
}
