/**
 * Voyage AI クライアント (PR #4 / T-03 提案エンジン v2 Phase 2)
 *
 * 役割:
 *   Voyage AI Embedding API (https://api.voyageai.com/v1/embeddings) への HTTP クライアント。
 *   公式 Node.js SDK は本記事執筆時点で未提供のため、`fetch` 直叩きで実装。
 *   API は OpenAI 互換のため将来 SDK 追加 / プロバイダ切替時の移行コストは低い。
 *
 * 設計判断:
 *   - **環境変数チェックは遅延**: `process.env.VOYAGE_API_KEY` は呼び出し時に検証。
 *     未設定なら `VoyageConfigError` を fail-closed で投げる (テスト・ローカル開発で
 *     起動時例外を回避)。
 *   - **外部 SDK を導入しない**: Voyage AI 公式 SDK が無いため、追加 dependency を増やさず
 *     Web 標準の `fetch` で十分。レスポンス shape は zod で検証。
 *   - **モック差替 helper**: テストで HTTP を実際に叩かないよう `_setVoyageFetcherForTest`
 *     で fetch 関数を差し替え可能。
 *
 * 認可境界:
 *   - 本ファイルは API キーの所有のみ責任を持つ。テナント認可・課金・rate limit は
 *     `withMeteredLLM` (src/lib/llm/metered.ts) が担当する。
 *   - すべての embedding 呼び出しは `withMeteredLLM` 越しに行うこと (直叩き禁止)。
 *
 * 関連:
 *   - 設定: src/config/llm.ts (LLM_MODELS.EMBEDDING / EMBEDDING_DIMENSIONS)
 *   - サービス: src/services/embedding.service.ts
 *   - 公式 API ドキュメント: https://docs.voyageai.com/reference/embeddings-api
 */

import { z } from 'zod';
import { LLM_MODELS, EMBEDDING_DIMENSIONS } from '@/config/llm';

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';

/** Voyage API 応答スキーマ。OpenAI 互換、`data[].embedding` に float 配列が入る。 */
const VoyageEmbeddingResponseSchema = z.object({
  object: z.string().optional(),
  data: z.array(
    z.object({
      object: z.string().optional(),
      embedding: z.array(z.number()),
      index: z.number().optional(),
    }),
  ),
  model: z.string().optional(),
  usage: z
    .object({
      total_tokens: z.number(),
    })
    .optional(),
});

export type VoyageEmbeddingResponse = z.infer<typeof VoyageEmbeddingResponseSchema>;

export interface VoyageEmbedInput {
  /** 1 つ以上の入力 text。Voyage は配列を受け入れ、要素数分の embedding を返す。 */
  texts: string[];
  /**
   * input_type ヒント。null/未指定で general 扱い。
   *   - 'document': コーパス側 (検索対象)
   *   - 'query': 検索クエリ側
   * 4 系では指定するとモデル側で対称化に使われる (公式推奨は document/query を使い分け)。
   */
  inputType?: 'document' | 'query';
}

export interface VoyageEmbedResult {
  /** texts と同じ順序の embedding 配列。各要素は EMBEDDING_DIMENSIONS 次元。 */
  embeddings: number[][];
  /** API が報告する累計トークン数 (課金根拠データに使用)。 */
  totalTokens: number;
}

/**
 * Voyage AI Embedding API 呼び出し設定不備で投げる例外。
 * withMeteredLLM の `llm_error` 経路で捕捉され、caller がフォールバック判断する。
 */
export class VoyageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoyageConfigError';
  }
}

/** Voyage API が 4xx/5xx を返した場合の例外。 */
export class VoyageApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'VoyageApiError';
  }
}

// ================================================================
// テスト用 fetch 差し替え機構
// ================================================================
type Fetcher = typeof globalThis.fetch;
let voyageFetcher: Fetcher | null = null;

/** テスト専用: 内部 fetch を差し替える (モック注入)。null セットでデフォルトに戻す。 */
export function _setVoyageFetcherForTest(fetcher: Fetcher | null): void {
  voyageFetcher = fetcher;
}

function getFetcher(): Fetcher {
  return voyageFetcher ?? globalThis.fetch;
}

// ================================================================
// 公開関数
// ================================================================

/**
 * Voyage AI Embedding API を 1 回呼び出し、texts の embedding ベクトルを取得する。
 *
 * @throws VoyageConfigError API キー未設定時
 * @throws VoyageApiError    API がエラー応答を返したとき
 * @throws Error              レスポンス JSON のパース失敗 / ネットワーク失敗
 */
export async function voyageEmbed(input: VoyageEmbedInput): Promise<VoyageEmbedResult> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    throw new VoyageConfigError(
      'VOYAGE_API_KEY 環境変数が未設定です。Vercel ダッシュボードで設定してください。',
    );
  }

  const body: Record<string, unknown> = {
    input: input.texts,
    model: LLM_MODELS.EMBEDDING,
    output_dimension: EMBEDDING_DIMENSIONS,
  };
  if (input.inputType != null) {
    body.input_type = input.inputType;
  }

  const fetcher = getFetcher();
  const res = await fetcher(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new VoyageApiError(
      res.status,
      `Voyage API error ${res.status}: ${detail.slice(0, 200)}`,
    );
  }

  const json: unknown = await res.json();
  const parsed = VoyageEmbeddingResponseSchema.parse(json);

  // 各 embedding が期待次元であることを検証 (出力次元のサニティチェック)
  for (const item of parsed.data) {
    if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Voyage embedding length ${item.embedding.length} != expected ${EMBEDDING_DIMENSIONS}`,
      );
    }
  }

  return {
    embeddings: parsed.data.map((d) => d.embedding),
    totalTokens: parsed.usage?.total_tokens ?? 0,
  };
}
