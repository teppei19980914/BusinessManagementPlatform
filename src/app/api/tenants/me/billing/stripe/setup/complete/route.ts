/**
 * GET /api/tenants/me/billing/stripe/setup/complete (PR-S3 / 2026-05-14)
 *
 * 役割:
 *   Stripe Checkout 完了後の戻り先ハンドラ。`POST /setup` で生成された Checkout Session の
 *   success_url がここを指す。session_id を取得して `completeStripeSetup()` を呼出し、
 *   Subscription 作成 + paymentMethod 切替を完了させる。
 *
 *   完了後は UI の `return_to` URL にリダイレクトし、トースト表示用のクエリパラメタを付与:
 *     - 成功: `?stripe_setup=success`
 *     - 失敗 (キャンセル / 検証失敗 / カード拒否): `?stripe_setup=failed&reason=<code>`
 *
 *   注意: tenant.paymentMethod は失敗時 invoice のまま (= 詳細設計 §A-1 で確定)
 *
 * 認可: admin role 必須 (= 同テナント管理者がログイン中である前提)
 *
 * Query:
 *   - session_id: Stripe Checkout Session ID (= `{CHECKOUT_SESSION_ID}` placeholder で展開済)
 *   - return_to: UI への最終戻り先 URL (= /settings/tenant)
 *
 * Response: 302 リダイレクト (= `return_to?stripe_setup=...`)
 *
 * 関連:
 *   仕様: docs/business/STRIPE_BILLING.md §4.1
 *   詳細設計: docs/design/STRIPE_TECHNICAL_DESIGN.md §A-1 (Phase 4-5)
 *   UI: docs/specification/STRIPE_PAYMENT_UI.md §2.4 (トースト表示)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { isStripeEnabled } from '@/lib/stripe';
import { completeStripeSetup } from '@/services/stripe-billing.service';
import { getTenantCurrentYearMonth } from '@/lib/tenant-time';
import { prisma } from '@/lib/db';

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (user instanceof NextResponse) return user;

  const forbidden = requireAdmin(user);
  if (forbidden) return forbidden;

  if (!isStripeEnabled()) {
    // feature flag 無効時はトップへフォールバック (= 想定外のアクセス、エラー表示なし)
    return NextResponse.redirect(new URL('/', req.url));
  }

  // クエリパラメタ取得
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('session_id');
  const returnTo = url.searchParams.get('return_to');

  // 安全な戻り先 URL を決定 (= return_to が不正なら /settings/tenant に固定)
  const safeReturnTo = sanitizeReturnTo(returnTo, req.url);

  // PR #425 デバッグ: Deploy Preview redirect 不具合の原因究明用 (検証完了後に削除)
  // eslint-disable-next-line no-console
  console.log('[stripe-setup-complete] debug', {
    reqUrl: req.url,
    returnTo,
    safeReturnTo,
    env_NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    env_URL: process.env.URL,
    env_DEPLOY_PRIME_URL: process.env.DEPLOY_PRIME_URL,
    env_CONTEXT: process.env.CONTEXT,
  });

  if (sessionId == null || sessionId.length === 0) {
    // session_id 欠落: 想定外 (Stripe placeholder 展開失敗 or 直接アクセス)
    return NextResponse.redirect(appendQuery(safeReturnTo, { stripe_setup: 'failed', reason: 'session_id_missing' }));
  }

  // billing_cycle_anchor を計算 (= JST 月初 UNIX 秒、詳細設計 §C-3)
  const tenant = await prisma.tenant.findUnique({
    where: { id: user.tenantId },
    select: { timezone: true },
  });
  const tz = tenant?.timezone ?? 'Asia/Tokyo';
  const yearMonth = getTenantCurrentYearMonth(new Date(), tz);
  // "2026-06" → 翌月 "2026-07-01 00:00 JST" の Unix 秒 (= billing_cycle_anchor)
  const [yearStr, monthStr] = yearMonth.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  // 翌月 1 日 00:00 JST = 前日 15:00 UTC
  const nextMonthStartUtc = Date.UTC(nextYear, nextMonth - 1, 1, 0, 0, 0) - 9 * 60 * 60 * 1000;
  const billingCycleAnchor = Math.floor(nextMonthStartUtc / 1000);

  // 完了処理を実行
  const result = await completeStripeSetup(user.tenantId, sessionId, billingCycleAnchor);

  if (result.ok) {
    return NextResponse.redirect(appendQuery(safeReturnTo, { stripe_setup: 'success' }));
  }

  // 失敗時: reason を UI 表示用にマッピング
  const reason = mapFailureReason(result);
  return NextResponse.redirect(
    appendQuery(safeReturnTo, { stripe_setup: 'failed', reason }),
  );
}

// ============================================================
// ヘルパ
// ============================================================

/**
 * return_to クエリパラメタを検証し、安全な戻り先 URL を返す。
 *
 * - 同一オリジンの URL のみ許可 (= オープンリダイレクト脆弱性対策)
 * - 失敗時は固定値 `/settings/tenant` にフォールバック
 *
 * PR #425 (2026-05-21): Netlify Deploy Preview 対応。
 *   Netlify Functions では req.url の origin が本番 URL (= tasukiba.netlify.app) に
 *   固定されるケースがあり、Deploy Preview URL (= deploy-preview-NNN--...) から来た
 *   returnTo が「異なるオリジン」として弾かれて本番 URL にフォールバックする事象が発生。
 *   対策: Netlify が自動設定する URL env var (= deploy context に応じて値が変化) も
 *   許可オリジンに加える。これでオープンリダイレクト対策を維持しつつ Deploy Preview /
 *   Branch Deploy でも正しい戻り先 URL にリダイレクトできる。
 */
function sanitizeReturnTo(returnTo: string | null, reqUrl: string): string {
  // PR #425 (2026-05-21): 複数の host source から候補を集める。
  //   Netlify Functions runtime では req.url の origin が canonical (= 本番) に固定される
  //   ケースがあり、また process.env.URL は build 時のみ有効で runtime では undefined。
  //   対策: 信頼できる複数 source から allowed origins を構築する。
  const allowedOrigins = new Set<string>();
  const candidateSources: Array<string | undefined | null> = [
    reqUrl, // req.url
    process.env.NEXTAUTH_URL, // build wrapper で deploy context に同期済 (= runtime でも有効)
    process.env.URL, // Netlify 自動設定 (build 時のみ有効、runtime では undefined の可能性)
    process.env.DEPLOY_PRIME_URL, // Netlify 自動設定 (deploy preview URL、build 時のみ)
  ];
  for (const source of candidateSources) {
    if (source) {
      try {
        allowedOrigins.add(new URL(source).origin);
      } catch {
        // 不正な URL は無視
      }
    }
  }

  // primaryOrigin: NEXTAUTH_URL (= deploy context に同期済) を最優先
  const primaryOrigin = (() => {
    if (process.env.NEXTAUTH_URL) {
      try {
        return new URL(process.env.NEXTAUTH_URL).origin;
      } catch {
        // fallthrough
      }
    }
    return new URL(reqUrl).origin;
  })();

  if (returnTo == null || returnTo.length === 0) {
    return `${primaryOrigin}/settings/tenant`;
  }
  try {
    const parsed = new URL(returnTo);
    if (!allowedOrigins.has(parsed.origin)) {
      // 異なるオリジンへのリダイレクトは禁止 (= オープンリダイレクト対策)
      return `${primaryOrigin}/settings/tenant`;
    }
    return parsed.toString();
  } catch {
    return `${primaryOrigin}/settings/tenant`;
  }
}

/**
 * URL にクエリパラメタを追加 (既存クエリは保持)。
 */
function appendQuery(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}

/**
 * StripeOperationResult のエラーを UI 表示用 reason コードに変換。
 */
function mapFailureReason(
  result: Awaited<ReturnType<typeof completeStripeSetup>>,
): string {
  if (result.ok) return 'success';
  switch (result.code) {
    case 'card_declined':
      return result.declineCode || 'card_declined';
    case 'authentication':
      return 'authentication_error';
    case 'connection':
      return 'connection_error';
    case 'rate_limit':
      return 'rate_limit';
    case 'invalid_request':
      // detail で詳細を返す (= session_status_expired / setup_intent_missing 等)
      return result.detail || 'invalid_request';
    case 'api_error':
    default:
      return 'processing_error';
  }
}
