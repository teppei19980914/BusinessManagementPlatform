/**
 * 認証系公開エンドポイント向け in-memory レート制限 (PR #198 で導入)。
 *
 * 目的:
 *   `/api/auth/reset-password`, `/api/auth/setup-password`, `/api/auth/lock-status`
 *   等の **認証不要・公開エンドポイント** にブルートフォース / スパム攻撃が来た場合の
 *   防御。CWE-307 (改善された認証メカニズムにおける制限の不在) 対策。
 *
 * 制限 (deliberately conservative defaults):
 *   - 同一 IP から **5 分間に 10 リクエスト** まで
 *   - 超過時は HTTP 429 Too Many Requests
 *
 * 設計判断 (Vercel serverless 環境での挙動):
 *   - Vercel は **複数 function instance** を起動するため、in-memory state は instance
 *     ごとに分離される (= 真の分散レート制限ではない)。Upstash Redis 等を使えば完全な
 *     分散制限が可能だが、追加コストとセットアップが必要。
 *   - **in-memory でも単一 instance に集中する典型的攻撃 (1 IP burst) には有効**。
 *     攻撃者がリクエストを意図的に分散できる場合は instance 数だけ multiplier がかかる
 *     が、**攻撃のコストを上げる多層防御の 1 層** として機能する。
 *   - 完全な制限が必要になった時点で Upstash Redis に切替予定 (T-XX 候補)。
 *
 * 使用例 (each route.ts の先頭):
 *   ```ts
 *   const limited = applyRateLimit(req, { key: 'reset-password' });
 *   if (limited) return limited;
 *   ```
 */

import { NextRequest, NextResponse } from 'next/server';

interface BucketEntry {
  /** 現在の window 内で受け付けた件数 */
  count: number;
  /** window がリセットされる epoch ms */
  resetAt: number;
}

interface RateLimitOptions {
  /** バケット名 (エンドポイント識別、複数経路で同 IP 制限を共用しないため分離) */
  key: string;
  /** window サイズ (ms)。既定 5 分。 */
  windowMs?: number;
  /** window 内の最大件数。既定 10。 */
  max?: number;
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 分
const DEFAULT_MAX = 10;

// instance-local の bucket store。serverless cold start で初期化されるが、
// それは攻撃者には予測困難な挙動なので一概に弱点ではない。
// Map のキーは `${key}:${ip}` 形式。
const buckets = new Map<string, BucketEntry>();

/** Map サイズ無制限増加を防ぐための定期 GC (lazy: 取得時に古いエントリを掃除) */
function gcExpired(now: number): void {
  // バケットが多すぎる時のみ走らせる (常時 GC はオーバヘッド)
  if (buckets.size < 1000) return;
  for (const [k, b] of buckets.entries()) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

/**
 * リクエスト元 IP を抽出する。Vercel/Cloudflare の `x-forwarded-for` を優先、
 * fallback で NextRequest.ip (Vercel は提供) → 'unknown'。
 */
function getClientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    // 'client, proxy1, proxy2' のうち先頭が真の client IP
    return xff.split(',')[0].trim();
  }
  // NextRequest.ip は実験的 API: Vercel runtime では存在、Node.js dev では undefined
  const ip = (req as unknown as { ip?: string }).ip;
  return ip || 'unknown';
}

/**
 * レート制限を適用し、超過時は 429 NextResponse を返す。OK なら null。
 *
 * 戻り値で route ハンドラ側は以下のように使う:
 *   const limited = applyRateLimit(req, { key: 'reset-password' });
 *   if (limited) return limited;
 *   // 通常の処理...
 */
export function applyRateLimit(
  req: NextRequest,
  opts: RateLimitOptions,
): NextResponse | null {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const max = opts.max ?? DEFAULT_MAX;
  const ip = getClientIp(req);
  const bucketKey = `${opts.key}:${ip}`;
  const now = Date.now();

  gcExpired(now);

  const entry = buckets.get(bucketKey);
  if (!entry || entry.resetAt <= now) {
    // 新規 window 開始
    buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return null;
  }

  if (entry.count >= max) {
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    return NextResponse.json(
      {
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: 'リクエスト回数が制限を超過しました。しばらく時間をおいて再度お試しください。',
        },
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(retryAfterSec),
          'X-RateLimit-Limit': String(max),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil(entry.resetAt / 1000)),
        },
      },
    );
  }

  entry.count += 1;
  return null;
}

/** テスト用の bucket クリア (production では呼ばない) */
export function _resetRateLimitBucketsForTest(): void {
  buckets.clear();
}

// ============================================================
// per-subject (tenantId / userId 等) レート制限 (ADR-0021 / 2026-05-26)
// ============================================================

interface SubjectRateLimitOptions {
  /** バケット名 (action 識別) */
  key: string;
  /** subject ID (tenantId / userId 等) */
  subjectId: string;
  /** window サイズ (ms)。既定 1 分。 */
  windowMs?: number;
  /** window 内の最大件数。既定 10。 */
  max?: number;
}

/**
 * subject (tenantId / userId 等) ベースのレート制限を適用する。IP ベースとは独立。
 *
 *   - per-tenant Pre-signed URL 発行: max=10/min (ADR-0021 §10.2.1)
 *   - per-tenant delete API: max=100/min (ADR-0021 §10.2.1)
 *
 * 戻り値: 超過時は 429 NextResponse、OK なら null。
 *
 * 注意:
 *   in-memory 実装 (= rate-limit.ts と同じ instance-local バケット)。
 *   Vercel/Netlify serverless では instance ごとに状態が分離されるが、
 *   1 instance に集中する典型攻撃には有効 (= 多層防御の 1 層)。
 */
export function applySubjectRateLimit(opts: SubjectRateLimitOptions): NextResponse | null {
  const windowMs = opts.windowMs ?? 60 * 1000;
  const max = opts.max ?? DEFAULT_MAX;
  const bucketKey = `${opts.key}:subject:${opts.subjectId}`;
  const now = Date.now();

  gcExpired(now);

  const entry = buckets.get(bucketKey);
  if (!entry || entry.resetAt <= now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return null;
  }

  if (entry.count >= max) {
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    return NextResponse.json(
      {
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: 'リクエスト回数が制限を超過しました。しばらく時間をおいて再度お試しください。',
        },
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(retryAfterSec),
          'X-RateLimit-Limit': String(max),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil(entry.resetAt / 1000)),
        },
      },
    );
  }

  entry.count += 1;
  return null;
}
