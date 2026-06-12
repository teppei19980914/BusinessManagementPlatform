/**
 * ADR-0035: runChunkedBulk のユニットテスト。
 *
 * 検証観点:
 *   - chunkArray の分割
 *   - 全成功 / 部分失敗 / sender 例外 の集計
 *   - finalize が「成功>0 のとき末尾 1 回だけ」呼ばれる / 全失敗時はスキップ
 *   - finalize の例外は finalizeError に集約 (チャンク結果は壊さない)
 *   - 上限付き並列 (同時実行数が concurrency を超えない)
 *   - onProgress の進捗通知
 */
import { describe, it, expect, vi } from 'vitest';
import { runChunkedBulk, chunkArray, type ChunkOutcome } from './run-chunked-bulk';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('chunkArray', () => {
  it('size 件ずつに分割する', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('size < 1 は 1 にクランプ', () => {
    expect(chunkArray([1, 2], 0)).toEqual([[1], [2]]);
  });
  it('空配列は空', () => {
    expect(chunkArray([], 3)).toEqual([]);
  });
});

describe('runChunkedBulk', () => {
  it('空 ID は sender を呼ばず total=0 を返す', async () => {
    const sender = vi.fn();
    const res = await runChunkedBulk([], sender);
    expect(res).toEqual({ total: 0, succeeded: 0, failedIds: [] });
    expect(sender).not.toHaveBeenCalled();
  });

  it('全成功: チャンク数分 sender を呼び succeeded=total', async () => {
    const sender = vi.fn(async (): Promise<ChunkOutcome> => ({ ok: true }));
    const res = await runChunkedBulk(ids(250), sender, { chunkSize: 100, concurrency: 3 });
    expect(sender).toHaveBeenCalledTimes(3); // 100 + 100 + 50
    expect(res.total).toBe(250);
    expect(res.succeeded).toBe(250);
    expect(res.failedIds).toEqual([]);
  });

  it('部分失敗: 失敗チャンクの ID を failedIds に集約', async () => {
    const sender = vi.fn(async (chunk: string[]): Promise<ChunkOutcome> =>
      chunk.includes('id-100') ? { ok: false, failedIds: chunk } : { ok: true },
    );
    const res = await runChunkedBulk(ids(250), sender, { chunkSize: 100, concurrency: 1 });
    // 2 番目のチャンク (id-100..id-199) が失敗
    expect(res.failedIds).toHaveLength(100);
    expect(res.failedIds).toContain('id-100');
    expect(res.succeeded).toBe(150);
  });

  it('sender が throw したチャンクは全 ID を失敗扱い', async () => {
    const sender = vi.fn(async (): Promise<ChunkOutcome> => {
      throw new Error('network');
    });
    const res = await runChunkedBulk(ids(10), sender, { chunkSize: 5 });
    expect(res.failedIds).toHaveLength(10);
    expect(res.succeeded).toBe(0);
  });

  it('finalize は成功>0 のとき末尾 1 回だけ呼ばれる', async () => {
    const finalize = vi.fn(async () => {});
    const res = await runChunkedBulk(ids(120), async () => ({ ok: true }), {
      chunkSize: 100,
      finalize,
    });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith({ succeeded: 120, failedIds: [] });
    expect(res.finalizeError).toBeUndefined();
  });

  it('全失敗 (succeeded=0) のとき finalize はスキップ', async () => {
    const finalize = vi.fn(async () => {});
    await runChunkedBulk(ids(5), async (chunk) => ({ ok: false, failedIds: chunk }), {
      chunkSize: 5,
      finalize,
    });
    expect(finalize).not.toHaveBeenCalled();
  });

  it('finalize の例外は finalizeError に集約 (チャンク成功結果は保持)', async () => {
    const res = await runChunkedBulk(ids(3), async () => ({ ok: true }), {
      chunkSize: 3,
      finalize: async () => {
        throw new Error('recalc failed');
      },
    });
    expect(res.succeeded).toBe(3);
    expect(res.finalizeError).toBe('recalc failed');
  });

  it('同時実行数は concurrency を超えない', async () => {
    let active = 0;
    let maxActive = 0;
    const sender = async (): Promise<ChunkOutcome> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick();
      active -= 1;
      return { ok: true };
    };
    await runChunkedBulk(ids(50), sender, { chunkSize: 5, concurrency: 2 }); // 10 チャンク
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('onProgress は最終的に (total, total) まで進む', async () => {
    const progress: Array<[number, number]> = [];
    await runChunkedBulk(ids(250), async () => ({ ok: true }), {
      chunkSize: 100,
      concurrency: 3,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(progress[0]).toEqual([0, 250]);
    expect(progress[progress.length - 1]).toEqual([250, 250]);
  });
});
