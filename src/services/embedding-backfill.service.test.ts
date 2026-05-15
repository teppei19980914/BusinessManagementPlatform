/**
 * embedding-backfill.service.ts の単体テスト (Q5(2) 月初 embedding 補完 / 2026-05-14)
 *
 * 検証項目:
 *   - 各テーブルから NULL embedding の行を取得し、空 text はフィルタすること
 *   - generateAndPersistBatchEmbeddings へ 1 度ずつ集約呼出すること
 *   - 1 テナント = テーブルごとに集計してテナント単位の結果が組み立てられること
 *   - 全テナント横断の runMonthlyEmbeddingBackfill が tenantCount を集計すること
 *   - countNullEmbeddings が 4 テーブルの件数を返すこと
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    tenant: {
      findMany: vi.fn(),
    },
  },
}));

const mockGenerateAndPersistBatch = vi.fn();
vi.mock('@/services/embedding.service', () => ({
  generateAndPersistBatchEmbeddings: (...args: unknown[]) =>
    mockGenerateAndPersistBatch(...args),
}));

// compose* 系は import 経由で読み込まれる real implementation を使う。テスト内では
// 入力 row を直接モックするため、compose の最終 text 出力は assertion 対象としない。

import {
  runMonthlyEmbeddingBackfill,
  backfillTenant,
  countNullEmbeddings,
} from './embedding-backfill.service';
import { prisma } from '@/lib/db';

describe('backfillTenant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateAndPersistBatch.mockReset();
  });

  it('各テーブルから NULL を取得し、空でないものを generateAndPersistBatchEmbeddings に渡す', async () => {
    // (2026-05-15) Memo (5 テーブル目) も対象に追加。
    // projects: 2 件 NULL (うち 1 件は空 text → filter で除外)
    // knowledges: 1 件 NULL
    // risks_issues / retrospectives / memos: 0 件
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        { id: 'p-1', purpose: 'プロジェクト目的', background: '', scope: '' },
        { id: 'p-empty', purpose: '', background: '', scope: '' }, // text 全空 → filter
      ] as never)
      .mockResolvedValueOnce([
        {
          id: 'k-1',
          title: '知見タイトル',
          background: '',
          content: '内容',
          result: '結果',
          conclusion: null,
          recommendation: null,
        },
      ] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    mockGenerateAndPersistBatch.mockImplementation(async ({ items }) => ({
      generated: items.length,
      failed: 0,
      costJpy: 1,
    }));

    const result = await backfillTenant('tenant-a');

    // projects は空 text を除外して 1 件のみ batch に渡る
    expect(mockGenerateAndPersistBatch).toHaveBeenCalledTimes(2);
    const projectsBatchCall = mockGenerateAndPersistBatch.mock.calls[0][0];
    expect(projectsBatchCall.tenantId).toBe('tenant-a');
    expect(projectsBatchCall.items).toHaveLength(1);
    expect(projectsBatchCall.items[0].rowId).toBe('p-1');
    expect(projectsBatchCall.featureUnit).toBe('project-embedding-backfill');

    const knowledgesBatchCall = mockGenerateAndPersistBatch.mock.calls[1][0];
    expect(knowledgesBatchCall.featureUnit).toBe('knowledge-embedding-backfill');

    expect(result.tenantId).toBe('tenant-a');
    expect(result.generated.projects).toBe(1);
    expect(result.generated.knowledges).toBe(1);
    expect(result.generated.risks_issues).toBe(0);
    expect(result.generated.retrospectives).toBe(0);
    expect(result.generated.memos).toBe(0);
  });

  it('1 件も NULL がなければ batch 呼出は発生しない (テーブル別に 0 件)', async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    const result = await backfillTenant('tenant-empty');

    expect(mockGenerateAndPersistBatch).not.toHaveBeenCalled();
    expect(result.generated.projects).toBe(0);
    expect(result.generated.knowledges).toBe(0);
    expect(result.generated.memos).toBe(0);
  });

  it('LLM 縮退 (上限超過) で 1 度の batch が全件 failed を返したら集計に反映する', async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        { id: 'p-1', purpose: 'p', background: '', scope: '' },
      ] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    mockGenerateAndPersistBatch.mockResolvedValueOnce({
      generated: 0,
      failed: 1,
      costJpy: 0,
    });

    const result = await backfillTenant('tenant-over-budget');

    expect(result.generated.projects).toBe(0);
    expect(result.failed.projects).toBe(1);
  });

  it('(2026-05-15) Memo (visibility=public) も backfill 対象になる', async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([] as never) // projects
      .mockResolvedValueOnce([] as never) // knowledges
      .mockResolvedValueOnce([] as never) // risks_issues
      .mockResolvedValueOnce([] as never) // retrospectives
      .mockResolvedValueOnce([
        { id: 'm-1', title: 'メモ', content: '本文' },
      ] as never); // memos

    mockGenerateAndPersistBatch.mockImplementation(async ({ items }) => ({
      generated: items.length,
      failed: 0,
      costJpy: 10,
    }));

    const result = await backfillTenant('tenant-with-memos');

    expect(mockGenerateAndPersistBatch).toHaveBeenCalledTimes(1);
    const memoBatchCall = mockGenerateAndPersistBatch.mock.calls[0][0];
    expect(memoBatchCall.featureUnit).toBe('memo-embedding-backfill');
    expect(memoBatchCall.items).toHaveLength(1);
    expect(memoBatchCall.items[0].rowId).toBe('m-1');
    expect(result.generated.memos).toBe(1);
  });
});

describe('runMonthlyEmbeddingBackfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateAndPersistBatch.mockReset();
  });

  it('全テナントを処理し件数集計を返す', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValueOnce([
      { id: 'tenant-a' },
      { id: 'tenant-b' },
    ] as never);

    // 各テナントに 4 テーブルの query。すべて空配列を返す簡易ケース。
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);

    const summary = await runMonthlyEmbeddingBackfill();
    expect(summary.tenantCount).toBe(2);
    expect(summary.results).toHaveLength(2);
    expect(summary.results[0].tenantId).toBe('tenant-a');
    expect(summary.results[1].tenantId).toBe('tenant-b');
  });
});

describe('countNullEmbeddings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('5 テーブル分の SQL UNION 結果を集計し total を返す', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { table_name: 'projects', count: 3n },
      { table_name: 'knowledges', count: 5n },
      { table_name: 'risks_issues', count: 1n },
      { table_name: 'retrospectives', count: 0n },
      { table_name: 'memos', count: 2n }, // (2026-05-15) Memo 追加
    ] as never);

    const counts = await countNullEmbeddings('tenant-a');
    expect(counts).toEqual({
      projects: 3,
      knowledges: 5,
      risksIssues: 1,
      retrospectives: 0,
      memos: 2,
      total: 11,
    });
  });

  it('テーブル結果が欠ける場合は 0 とみなす', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { table_name: 'projects', count: 2n },
    ] as never);

    const counts = await countNullEmbeddings('tenant-a');
    expect(counts).toEqual({
      projects: 2,
      knowledges: 0,
      risksIssues: 0,
      retrospectives: 0,
      memos: 0,
      total: 2,
    });
  });
});
