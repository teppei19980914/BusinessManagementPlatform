/**
 * src/config/suggestion.ts の単体テスト (PR-X6 / 段階表示 + 件数保証)
 *
 * 検証項目:
 *   - classifyTier(): スコア閾値で strong / medium / weak に正しく分類されるか
 *   - applyMinimumGuarantee(): 閾値以上の候補が最低件数未満なら全候補から Top N を返すか
 *   - 各境界値での挙動 (= ユーザの「0 件にしない」要件の構造保証)
 */

import { describe, it, expect } from 'vitest';
import {
  classifyTier,
  applyMinimumGuarantee,
  SUGGESTION_TIER_STRONG_THRESHOLD,
  SUGGESTION_TIER_MEDIUM_THRESHOLD,
  SUGGESTION_MINIMUM_GUARANTEED_COUNT,
  SUGGESTION_SCORE_THRESHOLD,
} from './suggestion';

describe('classifyTier', () => {
  it('strong threshold (0.3) 以上は strong', () => {
    expect(classifyTier(0.3)).toBe('strong');
    expect(classifyTier(0.5)).toBe('strong');
    expect(classifyTier(1.0)).toBe('strong');
  });

  it('strong threshold 直下 (0.3 未満) かつ medium threshold (0.1) 以上は medium', () => {
    expect(classifyTier(0.299)).toBe('medium');
    expect(classifyTier(0.2)).toBe('medium');
    expect(classifyTier(0.1)).toBe('medium');
  });

  it('medium threshold (0.1) 未満は weak', () => {
    expect(classifyTier(0.099)).toBe('weak');
    expect(classifyTier(0.05)).toBe('weak');
    expect(classifyTier(0)).toBe('weak');
  });

  it('PR-X6 設計値: 各 threshold は config と整合', () => {
    expect(SUGGESTION_TIER_STRONG_THRESHOLD).toBe(0.3);
    expect(SUGGESTION_TIER_MEDIUM_THRESHOLD).toBe(0.1);
  });
});

describe('applyMinimumGuarantee', () => {
  // helper: スコアだけ持つダミー候補を作る
  const c = (score: number, label = '') => ({ score, label });

  describe('通常パス: 閾値以上の候補が十分にある', () => {
    it('閾値以上が最低件数以上なら、閾値以上のみを返す', () => {
      const candidates = [c(0.5, 'a'), c(0.4, 'b'), c(0.3, 'c'), c(0.2, 'd'), c(0.05, 'e'), c(0.001, 'f')];
      const result = applyMinimumGuarantee(candidates, 0.05, 5);
      // 0.05 以上の 5 件 (a, b, c, d, e) が返る
      expect(result).toHaveLength(5);
      expect(result.map((r) => r.label)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('閾値以上が最低件数を上回る場合、全件 (閾値以上) を返す', () => {
      const candidates = [c(0.9), c(0.8), c(0.7), c(0.6), c(0.5), c(0.4), c(0.3), c(0.2), c(0.1)];
      const result = applyMinimumGuarantee(candidates, 0.05, 5);
      // 全件閾値以上なので全 9 件返る (limit 切り詰めは呼出側の責務)
      expect(result).toHaveLength(9);
    });
  });

  describe('件数保証パス: 閾値以上の候補が不足', () => {
    it('閾値以上が最低件数未満でも、Top N (5 件) を返す (= 0 件回避の構造保証)', () => {
      // 全候補がスコア 0.001 (= 閾値 0.05 未満) でも
      const candidates = [c(0.04, 'a'), c(0.03, 'b'), c(0.02, 'c'), c(0.01, 'd'), c(0.001, 'e'), c(0.0001, 'f')];
      const result = applyMinimumGuarantee(candidates, 0.05, 5);
      // 閾値以上は 0 件だが、最低保証で Top 5 (スコア降順) が返る
      expect(result).toHaveLength(5);
      expect(result.map((r) => r.label)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('閾値以上が部分的にあり、不足分を低スコア候補で埋める', () => {
      const candidates = [c(0.5, 'a'), c(0.3, 'b'), c(0.04, 'c'), c(0.03, 'd'), c(0.02, 'e'), c(0.01, 'f')];
      const result = applyMinimumGuarantee(candidates, 0.05, 5);
      // 閾値以上は a, b の 2 件のみ、不足するので Top 5 を返す
      expect(result).toHaveLength(5);
      expect(result.map((r) => r.label)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
  });

  describe('境界条件', () => {
    it('候補総数が最低件数未満なら、全件を返す (5 件保証は要求しない)', () => {
      const candidates = [c(0.04), c(0.03), c(0.001)];
      const result = applyMinimumGuarantee(candidates, 0.05, 5);
      // 全 3 件のみで Top 5 は要求できない
      expect(result).toHaveLength(3);
    });

    it('候補ゼロなら空配列', () => {
      const result = applyMinimumGuarantee([], 0.05, 5);
      expect(result).toHaveLength(0);
    });

    it('閾値以上が候補総数と一致する場合、その全件を返す', () => {
      const candidates = [c(0.5), c(0.4), c(0.3)];
      const result = applyMinimumGuarantee(candidates, 0.05, 5);
      // 全件閾値以上 (= 3 件)、最低 5 件未満だが候補総数も 3 件なので全件返す
      expect(result).toHaveLength(3);
    });
  });

  describe('PR-X6 設計値の整合性', () => {
    it('SUGGESTION_MINIMUM_GUARANTEED_COUNT は 5', () => {
      expect(SUGGESTION_MINIMUM_GUARANTEED_COUNT).toBe(5);
    });

    it('SUGGESTION_SCORE_THRESHOLD は 0.01 (PR-X6 で 0.05 → 0.01 に緩和)', () => {
      expect(SUGGESTION_SCORE_THRESHOLD).toBe(0.01);
    });

    it('デフォルト引数で動作する (= service 側の呼出パターン)', () => {
      const candidates = [c(0.04), c(0.03), c(0.02), c(0.01), c(0.005), c(0.001)];
      const result = applyMinimumGuarantee(candidates);
      // 閾値 0.01 以上は 4 件、最低保証 5 件未満なので Top 5 を返す
      expect(result).toHaveLength(5);
    });
  });

  describe('入力配列の不変性', () => {
    it('入力配列を破壊しない (新しい配列を返す)', () => {
      const original = [c(0.5, 'a'), c(0.3, 'b'), c(0.1, 'c')];
      const beforeOrder = original.map((c) => c.label);
      const result = applyMinimumGuarantee(original, 0.05, 5);
      // 入力の順序は破壊されない
      expect(original.map((c) => c.label)).toEqual(beforeOrder);
      // 戻り値は別の配列
      expect(result).not.toBe(original);
    });
  });

  describe('「0 件にしない」要件の構造保証 (ユーザ要望 2026-05-07)', () => {
    it('シードと完全に異なる業務領域でも、最低 5 件の候補が返る', () => {
      // 例: 養蜂業のプロジェクトで、シードはすべて IT / 経理 / 営業領域 → スコア全部 0.005 程度
      const candidates = Array.from({ length: 20 }, (_, i) => c((20 - i) * 0.0005));
      const result = applyMinimumGuarantee(candidates, SUGGESTION_SCORE_THRESHOLD);
      // 閾値 0.01 以上はゼロ件だが、Top 5 が返る (= 0 件にならない構造保証)
      expect(result.length).toBeGreaterThanOrEqual(SUGGESTION_MINIMUM_GUARANTEED_COUNT);
      expect(result.length).toBe(SUGGESTION_MINIMUM_GUARANTEED_COUNT);
    });
  });
});
