/**
 * Netlify Metrics Service (PR #425 / 2026-05-22)
 *
 * 役割:
 *   super_admin ダッシュボードに Netlify のビルド消費量を可視化するためのメトリクス取得 service。
 *   Netlify Personal integration credits 1,000/月 の超過予防・残量把握を運用者がリアルタイムに確認できるようにする。
 *
 * 設計:
 *   - **リアルタイム取得**: ダッシュボード表示時に Netlify API を 1 回叩く (= キャッシュなし、credit 大量消費しない前提)
 *   - **エラー時は空メトリクス + エラーメッセージ返却**: 取得失敗で画面遷移を妨げない
 *   - **credit 概算**: Netlify 公開 API に credits 専用 endpoint がないため、ビルド数 × 15 (= 1 build ≈ 15 credits) で推定
 *   - **環境変数**: `NETLIFY_API_TOKEN` (= Personal Access Token) + `NETLIFY_SITE_ID` が必須
 *
 * Netlify API: https://docs.netlify.com/api/get-started/
 * Personal Access Token 発行: https://app.netlify.com/user/applications#personal-access-tokens
 *
 * 関連 KDD §5.X+104: 請求堅牢性多層防御 (= 本 service は外部サービス consumed credits の早期検知)
 */

export type NetlifyMetrics = {
  /** 今月のビルド回数 (= JST 月初 〜 現在) */
  buildsThisMonth: number;
  /** 推定 integration credits 消費量 (= ビルド数 × 15) */
  estimatedCreditsUsed: number;
  /** 残り credits (Personal 1,000/月 - estimatedCreditsUsed、ADR-0023 で Starter から昇格) */
  estimatedCreditsRemaining: number;
  /** 最新ビルドの ISO 時刻 */
  latestBuildAt: string | null;
  /** 最新ビルドの状態 (ready / building / error / skipped 等) */
  latestBuildState: string;
  /** Netlify CONTEXT (production / deploy-preview 等) */
  latestBuildContext: string | null;
  /** 取得失敗時のエラーメッセージ (= UI で警告表示用) */
  error: string | null;
};

/**
 * Netlify API から最新メトリクスを取得する。
 *
 * @returns NetlifyMetrics (= 取得失敗時は error フィールドにメッセージ + 数値は 0)
 */
export async function getNetlifyMetrics(): Promise<NetlifyMetrics> {
  const token = process.env.NETLIFY_API_TOKEN;
  const siteId = process.env.NETLIFY_SITE_ID;

  if (!token || !siteId) {
    return emptyMetrics(
      `NETLIFY_API_TOKEN / NETLIFY_SITE_ID が未設定です。Netlify Dashboard で Personal Access Token を発行し、Netlify env var に設定してください。`,
    );
  }

  try {
    const res = await fetch(
      `https://api.netlify.com/api/v1/sites/${siteId}/builds?per_page=100`,
      {
        headers: { Authorization: `Bearer ${token}` },
        // Next.js cache を無効化 (= リアルタイム取得)
        cache: 'no-store',
      },
    );
    if (!res.ok) {
      return emptyMetrics(`Netlify API 失敗 (HTTP ${res.status})`);
    }
    const builds = (await res.json()) as Array<{
      created_at: string;
      state: string;
      context?: string;
    }>;

    // JST 月初 〜 現在 の builds を count
    // JST 月初 = UTC 前日 15:00。
    const now = new Date();
    const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const monthStartJst = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1, 0, 0, 0));
    const monthStartUtc = new Date(monthStartJst.getTime() - 9 * 60 * 60 * 1000);
    const thisMonthBuilds = builds.filter((b) => new Date(b.created_at) >= monthStartUtc);

    const PERSONAL_PLAN_CREDITS_PER_MONTH = 1000; // Netlify Personal Plan ($9/seat/month) の integration credits 上限。ADR-0023 で Starter→Personal 昇格 (Starter は 300/月、Personal は 1000/月)
    const CREDITS_PER_BUILD = 15; // 1 build ≈ 15 credits (Netlify 概算値、Public 公式値ではないため変動余地あり)
    const estimatedCreditsUsed = thisMonthBuilds.length * CREDITS_PER_BUILD;

    return {
      buildsThisMonth: thisMonthBuilds.length,
      estimatedCreditsUsed,
      estimatedCreditsRemaining: Math.max(0, PERSONAL_PLAN_CREDITS_PER_MONTH - estimatedCreditsUsed),
      latestBuildAt: builds[0]?.created_at ?? null,
      latestBuildState: builds[0]?.state ?? 'unknown',
      latestBuildContext: builds[0]?.context ?? null,
      error: null,
    };
  } catch (e) {
    return emptyMetrics(`Netlify API 通信エラー: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function emptyMetrics(error: string): NetlifyMetrics {
  return {
    buildsThisMonth: 0,
    estimatedCreditsUsed: 0,
    estimatedCreditsRemaining: 0,
    latestBuildAt: null,
    latestBuildState: 'unknown',
    latestBuildContext: null,
    error,
  };
}
