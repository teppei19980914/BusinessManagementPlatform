/**
 * runChunkedBulk — 大量 ID の一括操作を「チャンク分割 + 上限付き並列送信」で実行する共有ユーティリティ。
 *
 * 背景 (ADR-0035):
 *   Netlify 同期関数は 10 秒上限 (Personal)。全件を 1 リクエストに集約するとタイムアウト、
 *   1 件ずつ送ると遅い (認証/権限/per-row を件数分くり返す)。本 util は「件数を chunkSize で
 *   上限化した複数リクエスト」を最大 concurrency 本だけ並列に流すことで、各リクエストを
 *   確実にタイムアウト枠内に収めつつ全体スループットを上げる。
 *
 * 契約:
 *   - sender(chunkIds) は 1 チャンク分のサーバ呼び出しを行い、成否を ChunkOutcome で返す。
 *     成功なら { ok: true }、失敗なら { ok: false, failedIds } (failedIds 省略時は当該チャンク全件失敗扱い)。
 *   - 各チャンクが触れる ID は互いに素である前提 (削除/更新の対象集合は重複しない)。
 *     よって並列実行は安全 (同一行の競合なし)。
 *   - finalize は「全チャンク完了後に 1 回だけ」実行する後処理 (例: 全 WP 集計の再計算)。
 *     再計算をチャンクごとに走らせると O(WP) 走査が重複しタイムアウトに近づくため、末尾 1 回に集約する。
 *     成功チャンクが 1 件もない場合 (succeeded === 0) は finalize をスキップする。
 *
 * 冪等性:
 *   サーバ側の一括操作 (例: deletedAt: null 条件付き updateMany) が冪等であれば、
 *   失敗チャンクの再送 (retryFailed) は安全。本 util は失敗 ID を集約して返すので、
 *   呼び出し側は failedIds のみを再投入できる。
 */

export type ChunkOutcome = {
  ok: boolean;
  /** 失敗したチャンクで、失敗扱いにする ID 群。省略時は当該チャンク全 ID を失敗扱いにする。 */
  failedIds?: string[];
  /** 失敗理由 (UI 表示やログ用、任意)。 */
  error?: string;
};

export type RunChunkedBulkOptions = {
  /** 1 リクエストあたりの最大件数。既定 100 (ADR-0035)。 */
  chunkSize?: number;
  /** 同時に走らせるチャンク数の上限。既定 3 (ADR-0035)。 */
  concurrency?: number;
  /** 進捗通知。done = 処理済み件数 (成功/失敗問わず)、total = 全件数。 */
  onProgress?: (done: number, total: number) => void;
  /** 全チャンク完了後に 1 回だけ実行する後処理。succeeded > 0 のときのみ呼ばれる。 */
  finalize?: (summary: { succeeded: number; failedIds: string[] }) => Promise<void>;
};

export type RunChunkedBulkResult = {
  total: number;
  /** 成功した ID の件数 (= total - failedIds.length)。 */
  succeeded: number;
  /** 失敗した ID 群 (再送に使える)。 */
  failedIds: string[];
  /** finalize が throw した場合の理由 (チャンク自体は成功していても集計再計算等が失敗し得る)。 */
  finalizeError?: string;
};

/** items を size 件ずつのチャンクに分割する。size < 1 は 1 にクランプ。 */
export function chunkArray<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) {
    out.push(items.slice(i, i + n));
  }
  return out;
}

export async function runChunkedBulk(
  ids: string[],
  sender: (chunkIds: string[]) => Promise<ChunkOutcome>,
  options: RunChunkedBulkOptions = {},
): Promise<RunChunkedBulkResult> {
  const chunkSize = options.chunkSize ?? 100;
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const total = ids.length;

  if (total === 0) {
    return { total: 0, succeeded: 0, failedIds: [] };
  }

  const chunks = chunkArray(ids, chunkSize);
  const failedIds: string[] = [];
  let done = 0;
  options.onProgress?.(0, total);

  // 上限付き並列: 共有カーソルを worker が奪い合う。JS は単一スレッドで cursor++ と
  // 次の await の間に他 worker が割り込まないため、カーソル更新はアトミック。
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= chunks.length) break;
      const chunkIds = chunks[index];
      let outcome: ChunkOutcome;
      try {
        outcome = await sender(chunkIds);
      } catch (e) {
        outcome = { ok: false, failedIds: chunkIds, error: e instanceof Error ? e.message : String(e) };
      }
      if (!outcome.ok) {
        failedIds.push(...(outcome.failedIds ?? chunkIds));
      }
      done += chunkIds.length;
      options.onProgress?.(done, total);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()),
  );

  const succeeded = total - failedIds.length;

  let finalizeError: string | undefined;
  if (succeeded > 0 && options.finalize) {
    try {
      await options.finalize({ succeeded, failedIds });
    } catch (e) {
      finalizeError = e instanceof Error ? e.message : String(e);
    }
  }

  return { total, succeeded, failedIds, finalizeError };
}
