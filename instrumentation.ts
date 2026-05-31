/**
 * Next.js Instrumentation Hook
 *
 * サーバ起動時に 1 度だけ実行される。コールドスタート時の初回リクエストで
 * DB コネクション確立にかかる時間（TLS ネゴシエーション等）を前倒しする。
 *
 * 効果: 初回リクエストの TTFB を 50-150 ms 短縮（想定）
 * ref: docs/developer/performance/20260417/after/次期プログラム/cold-start-and-data-growth-analysis.md §4.1
 *
 * 公式ドキュメント:
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Edge Runtime では Prisma + pg adapter が動作しないため Node Runtime のみで実行
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // security/phase-3 (2026-05-31): DB region assertion (fail-fast)
    //   LP / プライバシーポリシーは「データ保存リージョン: ap-northeast-1 (東京)」と明記している。
    //   万一 Netlify env で DATABASE_URL を us-east-1 等に誤設定した場合、起動時に検出して fail させる。
    //   - 本番 (NODE_ENV=production) でのみ厳格に検証
    //   - localhost / Docker postgres は無条件で許容 (開発・CI)
    //   - Supabase pooler URL は `aws-0-ap-northeast-1.pooler.supabase.com` の形なので
    //     hostname に `ap-northeast-1` を含むことを確認
    if (process.env.NODE_ENV === 'production' && process.env.DATABASE_URL) {
      let dbHost: string;
      try {
        dbHost = new URL(process.env.DATABASE_URL).hostname.toLowerCase();
      } catch (e) {
        throw new Error(
          `[instrumentation] CRITICAL: DATABASE_URL is malformed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      const isLocal =
        dbHost === 'localhost' ||
        dbHost === '127.0.0.1' ||
        dbHost.endsWith('.local') ||
        dbHost.endsWith('.internal');
      const isJapanRegion = dbHost.includes('ap-northeast-1');
      if (!isLocal && !isJapanRegion) {
        throw new Error(
          `[instrumentation] CRITICAL: DATABASE_URL must point to ap-northeast-1 (jp region). ` +
            `Current host: ${dbHost}. ` +
            `Fix Netlify env DATABASE_URL or unset NODE_ENV=production for non-prod environments.`,
        );
      }
    }

    const { prisma } = await import('@/lib/db');
    try {
      await prisma.$connect();
    } catch (error) {
      // 起動時エラーで全リクエストを落とさない。ログのみ残し、初回リクエスト時に再試行させる
      console.error('[instrumentation] prisma.$connect() failed at startup:', error);
    }
  }
}
