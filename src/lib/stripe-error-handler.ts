/**
 * Stripe API エラーの統一ハンドラ (PR-S2 / 2026-05-14)
 *
 * 役割:
 *   Stripe SDK が throw する各種エラー型 (StripeCardError, StripeRateLimitError 等) を
 *   サービス層が扱いやすい Result 型に変換する。
 *
 * 設計方針:
 *   - **Result<T, E> 型で返却**: 例外を投げる代わりに `{ ok: true | false, ... }` を返す
 *   - **エラー種別ごとに code を統一**: 'card_declined' / 'rate_limit' / 'invalid_request' / etc.
 *   - **顧客向けメッセージ生成**: getDeclineMessage と連動 (= decline_code → 日本語)
 *   - **致命的エラー (authentication 等) は recordError でアラート**: 環境変数設定ミス等
 *
 * 関連:
 *   - 詳細設計: docs/design/STRIPE_TECHNICAL_DESIGN.md §B-1
 *   - 公式 Errors: https://docs.stripe.com/api/errors
 */

import Stripe from 'stripe';
import { getDeclineMessage } from './stripe-error-messages';

/**
 * Stripe API 呼出の結果型。
 *
 * - `{ ok: true, value: T }`: 成功
 * - `{ ok: false, code: ..., userMessage: ... }`: 失敗、UI に表示可能な文言付き
 */
export type StripeOperationResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: 'card_declined';
      declineCode: string;
      userMessage: string;
      severity: 'high' | 'medium' | 'low';
    }
  | { ok: false; code: 'rate_limit'; retryAfterSec: number; userMessage: string }
  | { ok: false; code: 'invalid_request'; userMessage: string; detail: string }
  | { ok: false; code: 'authentication'; userMessage: string }
  | { ok: false; code: 'connection'; userMessage: string }
  | { ok: false; code: 'api_error'; userMessage: string };

/**
 * Stripe API 呼出を Result 型でラップする高階関数。
 *
 * 使い方:
 * ```ts
 * const result = await withStripeError(() =>
 *   stripe.subscriptions.create({...})
 * );
 * if (!result.ok) {
 *   // result.code / result.userMessage を UI に渡す
 *   return { error: result.code, message: result.userMessage };
 * }
 * // result.value で成功時の値を取得
 * ```
 *
 * **致命的エラー (authentication)** は呼出側ではなくここで `recordError` を呼び、
 * super_admin にアラート (= 環境変数設定ミス等で本番が壊れている可能性)。
 *
 * @param fn Stripe API 呼出を実行する関数
 * @param onAuthError 致命的エラー時のアラートコールバック (= テスト容易性のため DI)
 */
export async function withStripeError<T>(
  fn: () => Promise<T>,
  onAuthError?: (error: Stripe.errors.StripeAuthenticationError) => Promise<void>,
): Promise<StripeOperationResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return await mapStripeError<T>(e, onAuthError);
  }
}

/**
 * Stripe エラーを Result 型に変換 (= テスト容易性のため withStripeError から分離)。
 *
 * 想定するエラー型は Stripe SDK の公式階層に従う:
 *   StripeError (base)
 *   ├ StripeCardError       — カード拒否 (= decline_code 付き)
 *   ├ StripeRateLimitError  — レート制限
 *   ├ StripeInvalidRequestError — リクエスト不正 (= パラメタ不正、リソース不在)
 *   ├ StripeAuthenticationError — API キー不正 (= 致命的、運営アラート)
 *   ├ StripeConnectionError — ネットワーク
 *   ├ StripeAPIError        — Stripe 側の 5xx
 *   └ (その他、StripePermissionError 等)
 */
async function mapStripeError<T>(
  e: unknown,
  onAuthError?: (error: Stripe.errors.StripeAuthenticationError) => Promise<void>,
): Promise<StripeOperationResult<T>> {
  if (e instanceof Stripe.errors.StripeCardError) {
    const msg = getDeclineMessage(e.decline_code);
    return {
      ok: false,
      code: 'card_declined',
      declineCode: e.decline_code ?? 'unknown',
      userMessage: msg.ja,
      severity: msg.severity,
    };
  }
  if (e instanceof Stripe.errors.StripeRateLimitError) {
    return {
      ok: false,
      code: 'rate_limit',
      retryAfterSec: 5,
      userMessage: 'リクエストが集中しています。時間をおいて再度お試しください',
    };
  }
  if (e instanceof Stripe.errors.StripeInvalidRequestError) {
    return {
      ok: false,
      code: 'invalid_request',
      userMessage: 'リクエストパラメタに誤りがあります',
      detail: e.message,
    };
  }
  if (e instanceof Stripe.errors.StripeAuthenticationError) {
    // 致命的エラー: 環境変数の API キー不正 → 運営にアラート
    if (onAuthError != null) {
      try {
        await onAuthError(e);
      } catch {
        // アラート失敗自体は無視 (= 主処理を止めない)
      }
    }
    return {
      ok: false,
      code: 'authentication',
      userMessage: '決済システムに一時的な問題が発生しています。運営にお問い合わせください',
    };
  }
  if (e instanceof Stripe.errors.StripeConnectionError) {
    return {
      ok: false,
      code: 'connection',
      userMessage: 'ネットワーク接続エラーが発生しました。時間をおいて再度お試しください',
    };
  }
  // 残り全部 (StripeAPIError, StripePermissionError, 等) は api_error 扱い
  return {
    ok: false,
    code: 'api_error',
    userMessage: 'Stripe 側で一時的なエラーが発生しています。時間をおいて再度お試しください',
  };
}

// テスト容易性のため named export
export { mapStripeError };
