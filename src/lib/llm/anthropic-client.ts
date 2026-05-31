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
  // ★テスト専用★ E2E スタブ provider (test/release-acceptance-e2e / 2026-06)。
  //   CI の E2E では ANTHROPIC_API_KEY を設定しないため、LLM_PROVIDER=stub のとき
  //   help-chat 出力スキーマに合致する定型 JSON を返す擬似クライアントを返し、ヘルプチャット
  //   の配線 (FAB → help タブ → 回答バブル) を鍵なしで通せるようにする。
  //   ★安全モデル★ MAIL_PROVIDER=inbox と同じ明示 opt-in。本番は LLM_PROVIDER を設定しない。
  //   NODE_ENV では分岐しない (E2E standalone は NODE_ENV=production で起動するため)。
  if (isLlmStubEnabled()) {
    cachedClient = createStubAnthropicClient();
    return cachedClient;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    throw new AnthropicConfigError(
      'ANTHROPIC_API_KEY 環境変数が未設定です。Netlify ダッシュボードで設定してください。',
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

// ================================================================
// テスト専用: E2E スタブ provider (test/release-acceptance-e2e / 2026-06)
// ================================================================

/**
 * LLM_PROVIDER=stub のときのみ true (E2E スタブ provider)。
 *
 * ★安全モデル★: MAIL_PROVIDER=inbox と同じ明示 opt-in env 方式。本番デプロイは LLM_PROVIDER を
 * 設定しない (= 既定で実 Anthropic)。NODE_ENV では分岐しない: E2E standalone サーバは production
 * build を `NODE_ENV=production` で起動するため、NODE_ENV ガードはスタブを永久無効化する
 * (PR #476 初回 CI で発覚)。本番では本 env を絶対に設定しないこと。
 */
export function isLlmStubEnabled(): boolean {
  return process.env.LLM_PROVIDER === 'stub';
}

/**
 * help-chat 出力スキーマ (answer/answerType/sourceFaqIds/sourceGuideStepIds/suggestSemanticSearch)
 * に合致する定型 JSON を返す擬似 Anthropic クライアント (E2E スタブ用)。
 *
 * messages.create の戻り値は本物の SDK Message と同じ最小 shape (content[].text / usage) を満たす。
 * 注: 本クライアントはヘルプチャットの配線検証専用。auto-tag / suggestion-explanation 等
 * 別スキーマを期待する呼出元がスタブ環境で叩いた場合は各呼出元の parse が失敗するが、
 * それらは best-effort (catch) のため致命的にはならない (E2E では検証対象外)。
 */
function createStubAnthropicClient(): Anthropic {
  const cannedHelpChatJson = JSON.stringify({
    answer: '（E2E スタブ応答）ただいまテストモードのため、定型の回答をお返ししています。',
    answerType: 'faq',
    sourceFaqIds: [],
    sourceGuideStepIds: [],
    suggestSemanticSearch: false,
  });
  const stub = {
    messages: {
      create: async () => ({
        id: 'msg_e2e_stub',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'end_turn',
        stop_sequence: null,
        content: [{ type: 'text', text: cannedHelpChatJson }],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    },
  };
  return stub as unknown as Anthropic;
}
