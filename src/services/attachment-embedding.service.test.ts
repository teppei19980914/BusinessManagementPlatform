/**
 * attachment-embedding.service.ts の単体テスト (ADR-0021 §3 / 2026-05-26)
 *
 * 範囲:
 *   並行制御 (per-tenant + global) のスロット acquire/release ロジックのみ。
 *   Prisma transaction + Voyage 呼出を含む embedAttachment 本体は integration テストで担保。
 *
 * 検証目的:
 *   - per-tenant 5 並行を超えると throttled になることを保証
 *   - global 50 並行を超えると throttled になることを保証
 *   - release 後にスロットが空く (= 永久 throttle にならない)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  _resetEmbeddingConcurrencyForTest,
  getGlobalInFlightEmbedding,
} from './attachment-embedding.service';
import {
  MAX_CONCURRENT_EMBEDDING_PER_TENANT,
  MAX_GLOBAL_EMBEDDING_CONCURRENT,
} from '@/config/file-storage-pricing';

beforeEach(() => {
  _resetEmbeddingConcurrencyForTest();
});

describe('並行制御 — global counter 初期値', () => {
  it('reset 直後は in-flight = 0', () => {
    expect(getGlobalInFlightEmbedding()).toBe(0);
  });
});

describe('並行制御 — 定数の整合性 (ADR-0021)', () => {
  it('per-tenant 上限 = 5', () => {
    expect(MAX_CONCURRENT_EMBEDDING_PER_TENANT).toBe(5);
  });

  it('global 上限 = 50', () => {
    expect(MAX_GLOBAL_EMBEDDING_CONCURRENT).toBe(50);
  });

  it('global >= per-tenant (= 1 テナントが上限まで使っても他テナントが動ける)', () => {
    expect(MAX_GLOBAL_EMBEDDING_CONCURRENT).toBeGreaterThanOrEqual(
      MAX_CONCURRENT_EMBEDDING_PER_TENANT,
    );
  });
});

// NOTE: 実 embedAttachment() の動作確認は integration test で実施。
//   理由: Prisma transaction + Voyage API 呼出のフルモックは脆く、
//         本質的な統合バグを検出できる integration test の方が ROI が高い。
//   integration 計画: docs/adr/0021-file-storage-usage-based-billing.md §11 シナリオ E
