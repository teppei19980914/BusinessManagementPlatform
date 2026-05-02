/**
 * LLM 呼び出し向け rate limiter (PR #2-c / T-03 提案エンジン v2)
 *
 * 抽象化:
 *   `RateLimiter` interface に対し、現状は **InMemoryRateLimiter** のみを提供。
 *   将来 Upstash Redis のセットアップ完了後に **UpstashRateLimiter** を追加し、
 *   factory `getDefaultRateLimiter()` の分岐に組み込む (env var で切替予定)。
 *
 * 設計判断:
 *   - 既存 src/lib/rate-limit.ts は IP ベースの認証エンドポイント用なのに対し、
 *     本モジュールは **userId ベース** で LLM 呼び出し専用。共通化せず分離する
 *     (キー設計と数値設定が異なるため)。
 *   - Vercel serverless 環境では in-memory 実装は instance-local で完全な
 *     分散制限にならない。ただし bot 級の連打を抑える効果はあり、Upstash 移行
 *     完了までの暫定として機能する。
 *   - Upstash 切替時の移行コストを下げるため、interface を最小限に絞り、
 *     check メソッド 1 本で「許可 / 拒否 + retryAfter」を返す API に統一。
 *
 * 関連:
 *   - 数値定数: src/config/llm.ts (LLM_RATE_LIMIT)
 *   - 利用箇所: src/lib/llm/metered.ts (withMeteredLLM ミドルウェア)
 */

export interface RateLimitCheckResult {
  /** true なら許可、false なら拒否 (この時 retryAfterSec が利用可能)。 */
  allowed: boolean;
  /** 拒否時に「何秒後に再試行可能か」を秒単位で返す (UI / 429 ヘッダ用)。 */
  retryAfterSec?: number;
}

export interface RateLimitOptions {
  /** window 内の最大件数。 */
  limit: number;
  /** window のサイズ (秒)。例: 60 (1 分)、3600 (1 時間)。 */
  windowSec: number;
}

export interface RateLimiter {
  /**
   * 指定キーに対する rate limit を 1 件消費し、超過判定を返す。
   * 許可時はカウンタが増加し、拒否時は変化なし (典型的な fixed-window 実装)。
   *
   * @param key 識別キー (例: `llm:${userId}:min`)
   * @param opts limit + windowSec
   */
  check(key: string, opts: RateLimitOptions): Promise<RateLimitCheckResult>;
}

// ----------------------------------------------------------------
// In-memory implementation
// ----------------------------------------------------------------

interface InMemoryBucket {
  count: number;
  resetAt: number; // epoch ms
}

/**
 * Vercel serverless function instance ごとに独立した状態を持つ in-memory 実装。
 *
 * 注意: 真の分散 rate limit ではない (instance 数だけ multiplier あり)。
 * 本格運用 (大量ユーザ) では Upstash Redis 実装に切り替えること。
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, InMemoryBucket>();
  private readonly maxSize: number;

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  async check(key: string, opts: RateLimitOptions): Promise<RateLimitCheckResult> {
    const now = Date.now();
    this.gcExpired(now);

    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + opts.windowSec * 1000 });
      return { allowed: true };
    }

    if (bucket.count >= opts.limit) {
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }

    bucket.count += 1;
    return { allowed: true };
  }

  /** Map サイズ無制限増加を防ぐための lazy GC。 */
  private gcExpired(now: number): void {
    if (this.buckets.size < this.maxSize) return;
    for (const [k, b] of this.buckets.entries()) {
      if (b.resetAt <= now) this.buckets.delete(k);
    }
  }

  /** テスト専用: バケットを全クリア。 */
  _resetForTest(): void {
    this.buckets.clear();
  }

  /** テスト専用: 内部状態を観察。 */
  _peekForTest(key: string): InMemoryBucket | undefined {
    return this.buckets.get(key);
  }
}

// ----------------------------------------------------------------
// Default instance / factory
// ----------------------------------------------------------------

/**
 * モジュールスコープのデフォルト rate limiter。
 *
 * 将来 Upstash 切替時はここを `process.env.UPSTASH_REDIS_REST_URL` の有無で
 * 分岐させる予定 (UpstashRateLimiter or InMemoryRateLimiter)。
 */
let defaultRateLimiter: RateLimiter | null = null;

export function getDefaultRateLimiter(): RateLimiter {
  if (defaultRateLimiter == null) {
    defaultRateLimiter = new InMemoryRateLimiter();
  }
  return defaultRateLimiter;
}

/**
 * テスト専用: デフォルトインスタンスを差し替え可能にする。
 * 引数 null で getDefaultRateLimiter の遅延初期化を再開する。
 */
export function _setDefaultRateLimiterForTest(rl: RateLimiter | null): void {
  defaultRateLimiter = rl;
}
