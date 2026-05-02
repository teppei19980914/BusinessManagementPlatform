/**
 * Anthropic Claude SDK クライアント (PR #3 / T-03 Phase 1)
 *
 * 役割:
 *   `@anthropic-ai/sdk` の Anthropic クラスを singleton で初期化し、
 *   API キー設定漏れを fail-closed に検出する。
 *
 * 設計判断:
 *   - **遅延初期化**: モジュール import 時に env チェックすると、テストや
 *     ローカル開発で API キー無しの起動が落ちる。lazy 初期化 + 呼び出し時例外で
 *     必要なときだけ検証する。
 *   - **singleton**: SDK 内部で HTTP keep-alive を持つため、リクエストごとに
 *     new するとコネクションプールが活かせない。
 *   - **テスト用 setter**: `_setAnthropicClientForTest` でモック差し替え可能。
 *
 * 認可境界:
 *   - 本ファイルは API キーの所有のみ責任を持つ。テナント認可・課金・rate limit は
 *     `withMeteredLLM` (src/lib/llm/metered.ts) が担当する。
 *   - すべての Claude 呼び出しは `withMeteredLLM` 越しに行うこと (直叩き禁止)。
 *
 * 関連:
 *   - 設定: src/config/llm.ts (LLM_MODELS)
 *   - ミドルウェア: src/lib/llm/metered.ts (withMeteredLLM)
 *   - 設計: docs/design/SUGGESTION_ENGINE.md
 */

import Anthropic from '@anthropic-ai/sdk';

let cachedClient: Anthropic | null = null;

/**
 * 本サービスで使う Anthropic クライアントを返す (singleton)。
 *
 * - 初回呼び出し時に `process.env.ANTHROPIC_API_KEY` を読み、未設定なら
 *   `AnthropicConfigError` を投げる (fail-closed)。
 * - 2 回目以降はキャッシュを返す。
 */
export function getAnthropicClient(): Anthropic {
  if (cachedClient != null) {
    return cachedClient;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    throw new AnthropicConfigError(
      'ANTHROPIC_API_KEY 環境変数が未設定です。Vercel ダッシュボードで設定してください。',
    );
  }
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

/**
 * Anthropic クライアント設定不備で投げる例外。
 * withMeteredLLM の `llm_error` 経路で捕捉され、caller がフォールバック判断する。
 */
export class AnthropicConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnthropicConfigError';
  }
}

/**
 * テスト専用: クライアントを差し替える (モック注入)。
 * null セットで遅延初期化に戻す。
 */
export function _setAnthropicClientForTest(
  client: Anthropic | null,
): void {
  cachedClient = client;
}
