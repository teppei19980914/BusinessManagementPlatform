/**
 * scripts/generate-faq-embeddings.ts の純粋ロジック検証 (ADR-0028)
 *
 * 担保対象:
 *   - __testing.emptyStats: stats 初期値が table key を持つ
 *   - __testing.vectorLiteral: 1024 次元配列を pgvector text 形式に正しく整形
 *   - syncFaqTable / syncGuideTable: dry-run mode で DB 書込せず stats のみ返す
 *     - 行が無ければ全件 added
 *     - hash 一致なら unchanged
 *     - hash 相違なら updated
 *     - config から削除済の DB 行は deleted カウント
 *
 * 注: 本 test は dry-run mode 経路のみカバー (= voyageEmbed を呼ばない)。
 *     実 embedding 生成は手動 / deploy 時の実行で確認する (developer-guide §7)。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { __testing } from '../../../scripts/generate-faq-embeddings';
import { FAQ_ENTRIES } from '@/config/faq-content';
import { GUIDE_STEPS } from '@/config/guide-content';
import {
  composeFaqContentText,
  composeGuideContentText,
  computeContentHash,
} from '@/services/help-search.service';

interface FakePrisma {
  $queryRaw: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
}

function makePrisma(existingRows: Array<{ id: string; entry_id: string; content_hash: string }>): FakePrisma {
  return {
    $queryRaw: vi.fn().mockResolvedValue(existingRows),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('emptyStats', () => {
  it('table key を保持して数値を 0 初期化', () => {
    const s = __testing.emptyStats('faq_embeddings');
    expect(s).toEqual({
      table: 'faq_embeddings',
      added: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      failed: 0,
    });
  });
});

describe('vectorLiteral', () => {
  it('配列を pgvector text 形式 [a,b,c] に整形', () => {
    expect(__testing.vectorLiteral([1, 2, 3])).toBe('[1,2,3]');
  });

  it('1024 次元配列もブラケットで囲んで整形', () => {
    const v = Array.from({ length: 1024 }, (_, i) => i * 0.001);
    const out = __testing.vectorLiteral(v);
    expect(out.startsWith('[0,0.001,0.002')).toBe(true);
    expect(out.endsWith(']')).toBe(true);
  });
});

describe('syncFaqTable (dry-run)', () => {
  it('DB 行ゼロなら FAQ_ENTRIES 全件を added にカウント (voyageEmbed 呼ばず)', async () => {
    const prisma = makePrisma([]);
    // 本 test は dry-run で呼ぶため voyageEmbed には到達しない (型エラー回避のため as unknown キャスト)
    const stats = await __testing.syncFaqTable(prisma as unknown as never, true);
    expect(stats.table).toBe('faq_embeddings');
    expect(stats.added).toBe(FAQ_ENTRIES.length);
    expect(stats.updated).toBe(0);
    expect(stats.unchanged).toBe(0);
    expect(stats.deleted).toBe(0);
    expect(stats.failed).toBe(0);
    // dry-run でも DB SELECT は実行される
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    // dry-run なので $executeRaw (insert/delete) は呼ばれない
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('全件が hash 一致なら全件 unchanged、書込なし', async () => {
    const existing = FAQ_ENTRIES.map((e) => ({
      id: `db-${e.id}`,
      entry_id: e.id,
      content_hash: computeContentHash(composeFaqContentText(e)),
    }));
    const prisma = makePrisma(existing);
    const stats = await __testing.syncFaqTable(prisma as unknown as never, true);
    expect(stats.unchanged).toBe(FAQ_ENTRIES.length);
    expect(stats.added).toBe(0);
    expect(stats.updated).toBe(0);
    expect(stats.deleted).toBe(0);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('1 件の hash 不一致 → updated 1 件、残りは unchanged', async () => {
    const existing = FAQ_ENTRIES.map((e, idx) => ({
      id: `db-${e.id}`,
      entry_id: e.id,
      content_hash:
        idx === 0
          ? 'staledigeststaledigeststaledigeststaledigeststaledigeststaledige'
          : computeContentHash(composeFaqContentText(e)),
    }));
    const prisma = makePrisma(existing);
    const stats = await __testing.syncFaqTable(prisma as unknown as never, true);
    expect(stats.updated).toBe(1);
    expect(stats.unchanged).toBe(FAQ_ENTRIES.length - 1);
    expect(stats.added).toBe(0);
  });

  it('config に存在しない DB 行は deleted', async () => {
    const existing = [
      // 既存と一致する 1 件
      {
        id: 'db-known',
        entry_id: FAQ_ENTRIES[0].id,
        content_hash: computeContentHash(composeFaqContentText(FAQ_ENTRIES[0])),
      },
      // config から削除された orphan
      {
        id: 'db-orphan',
        entry_id: 'definitely-removed-from-config',
        content_hash: 'irrelevant',
      },
    ];
    const prisma = makePrisma(existing);
    const stats = await __testing.syncFaqTable(prisma as unknown as never, true);
    expect(stats.deleted).toBe(1);
    expect(stats.unchanged).toBe(1);
    // FAQ_ENTRIES の 1 件目以外は新規追加
    expect(stats.added).toBe(FAQ_ENTRIES.length - 1);
  });
});

describe('syncGuideTable (dry-run)', () => {
  it('DB 行ゼロなら GUIDE_STEPS 全件を added にカウント', async () => {
    const prisma = makePrisma([]);
    const stats = await __testing.syncGuideTable(prisma as unknown as never, true);
    expect(stats.table).toBe('guide_embeddings');
    expect(stats.added).toBe(GUIDE_STEPS.length);
    expect(stats.updated).toBe(0);
    expect(stats.unchanged).toBe(0);
  });

  it('全件 hash 一致なら全件 unchanged', async () => {
    const existing = GUIDE_STEPS.map((s) => ({
      id: `db-${s.id}`,
      entry_id: s.id,
      content_hash: computeContentHash(composeGuideContentText(s)),
    }));
    const prisma = makePrisma(existing);
    const stats = await __testing.syncGuideTable(prisma as unknown as never, true);
    expect(stats.unchanged).toBe(GUIDE_STEPS.length);
    expect(stats.deleted).toBe(0);
  });
});
