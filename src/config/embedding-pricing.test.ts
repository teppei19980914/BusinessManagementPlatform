/**
 * embedding-pricing.ts のユニットテスト (ADR-0022 / 2026-06-01)
 *
 * 本テストは plan 別単価を **明示的に固定** する。将来「単価を変えたつもりはなかったのに
 * 変わっていた」事故を防ぐため、各プランの単価を 1 件ずつ確認する。
 */
import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_PRICE_JPY_BY_PLAN,
  resolveEmbeddingCostJpy,
} from './embedding-pricing';

describe('EMBEDDING_PRICE_JPY_BY_PLAN (ADR-0022 / ADR-0029 で ¥1→¥5 改定)', () => {
  it('Beginner は ¥0 (= 「90 日完全無料」訴求保全)', () => {
    expect(EMBEDDING_PRICE_JPY_BY_PLAN.beginner).toBe(0);
  });

  it('Expert は ¥5 (ADR-0029 / 2026-05-30 改定、旧 ¥1)', () => {
    expect(EMBEDDING_PRICE_JPY_BY_PLAN.expert).toBe(5);
  });

  it('Pro は ¥5 (Expert と同単価 = Embedding は plan 間で品質差なし)', () => {
    expect(EMBEDDING_PRICE_JPY_BY_PLAN.pro).toBe(5);
  });

  it('全プランの単価が定義されている (= TenantPlan 型と完全網羅)', () => {
    const keys = Object.keys(EMBEDDING_PRICE_JPY_BY_PLAN).sort();
    expect(keys).toEqual(['beginner', 'expert', 'pro']);
  });
});

describe('resolveEmbeddingCostJpy', () => {
  it('Beginner は 0 を返す', () => {
    expect(resolveEmbeddingCostJpy('beginner')).toBe(0);
  });

  it('Expert は 5 を返す (ADR-0029)', () => {
    expect(resolveEmbeddingCostJpy('expert')).toBe(5);
  });

  it('Pro は 5 を返す (ADR-0029)', () => {
    expect(resolveEmbeddingCostJpy('pro')).toBe(5);
  });

  it('★invariant★ 全戻り値が非負整数 (= 円整数の制約)', () => {
    const plans = ['beginner', 'expert', 'pro'] as const;
    for (const plan of plans) {
      const cost = resolveEmbeddingCostJpy(plan);
      expect(Number.isInteger(cost)).toBe(true);
      expect(cost).toBeGreaterThanOrEqual(0);
    }
  });

  it('Beginner プラン単価 = 0 不変条件 (= LP 訴求保全の最重要ガード)', () => {
    // この条件が壊れると Beginner ユーザに課金が発生し、消費者契約法/景品表示法リスク。
    // 単価変更時は必ず ADR を起こし、本テストを更新すること。
    expect(resolveEmbeddingCostJpy('beginner')).toBe(0);
  });
});
