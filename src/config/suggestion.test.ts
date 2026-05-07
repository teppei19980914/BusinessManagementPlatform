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
  assignPercentileTiers,
  SUGGESTION_TIER_STRONG_THRESHOLD,
  SUGGESTION_TIER_MEDIUM_THRESHOLD,
  SUGGESTION_MINIMUM_GUARANTEED_COUNT,
  SUGGESTION_SCORE_THRESHOLD,
  SUGGESTION_TIER_PERCENTILE_STRONG_RATIO,
  SUGGESTION_TIER_PERCENTILE_MEDIUM_RATIO,
  SUGGESTION_TIER_ABSOLUTE_FLOOR_FOR_STRONG,
  SUGGESTION_TIER_PERCENTILE_FALLBACK_THRESHOLD,
  type SuggestionTier,
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

describe('assignPercentileTiers (P-1 / 2026-05-08)', () => {
  // helper: スコア + 既存 tier (placeholder) を持つダミー候補を作る
  const c = (score: number, label = ''): { score: number; tier: SuggestionTier; label: string } => ({
    score,
    tier: classifyTier(score),
    label,
  });

  describe('境界条件', () => {
    it('空配列なら空配列', () => {
      expect(assignPercentileTiers([])).toEqual([]);
    });

    it('1 件のみ: 絶対閾値方式にフォールバック', () => {
      // score 0.4 (>= strong threshold 0.3) → strong
      expect(assignPercentileTiers([c(0.4)])[0].tier).toBe('strong');
      // score 0.2 (medium 範囲) → medium
      expect(assignPercentileTiers([c(0.2)])[0].tier).toBe('medium');
      // score 0.05 (weak 範囲) → weak
      expect(assignPercentileTiers([c(0.05)])[0].tier).toBe('weak');
    });

    it('5 件 (= フォールバック境界): 絶対閾値方式が適用される', () => {
      const items = [c(0.5), c(0.4), c(0.2), c(0.05), c(0.01)];
      const result = assignPercentileTiers(items);
      expect(result.map((r) => r.tier)).toEqual(['strong', 'strong', 'medium', 'weak', 'weak']);
    });
  });

  describe('パーセンタイル分類 (6 件以上)', () => {
    it('10 件: 上位 30% (3 件) strong / 中段 50% (5 件) medium / 下位 20% (2 件) weak', () => {
      // 全件高スコア (絶対閾値では全件 strong) でも、相対順位で 3/5/2 に分かれる
      const items = Array.from({ length: 10 }, (_, i) => c(0.9 - i * 0.05, `i${i}`));
      const result = assignPercentileTiers(items);
      const tiers = result.map((r) => r.tier);
      expect(tiers.filter((t) => t === 'strong')).toHaveLength(3);
      expect(tiers.filter((t) => t === 'medium')).toHaveLength(5);
      expect(tiers.filter((t) => t === 'weak')).toHaveLength(2);
      // 並び順: strong → medium → weak (スコア降順)
      expect(tiers).toEqual(['strong', 'strong', 'strong', 'medium', 'medium', 'medium', 'medium', 'medium', 'weak', 'weak']);
    });

    it('20 件: 上位 6 件 (30%) strong / 続く 10 件 (50%) medium / 下位 4 件 (20%) weak', () => {
      const items = Array.from({ length: 20 }, (_, i) => c(0.95 - i * 0.04, `i${i}`));
      const result = assignPercentileTiers(items);
      const tiers = result.map((r) => r.tier);
      expect(tiers.filter((t) => t === 'strong')).toHaveLength(6);
      expect(tiers.filter((t) => t === 'medium')).toHaveLength(10);
      expect(tiers.filter((t) => t === 'weak')).toHaveLength(4);
    });

    it('6 件 (端数あり): Math.ceil で strong=2, medium=3, weak=1', () => {
      // ceil(6 * 0.3) = 2, ceil(6 * 0.5) = 3, weak = 6 - 2 - 3 = 1
      const items = Array.from({ length: 6 }, (_, i) => c(0.9 - i * 0.05, `i${i}`));
      const result = assignPercentileTiers(items);
      const tiers = result.map((r) => r.tier);
      expect(tiers.filter((t) => t === 'strong')).toHaveLength(2);
      expect(tiers.filter((t) => t === 'medium')).toHaveLength(3);
      expect(tiers.filter((t) => t === 'weak')).toHaveLength(1);
    });

    it('7 件 (端数あり): Math.ceil で strong=3, medium=4, weak=0', () => {
      // ceil(7 * 0.3) = ceil(2.1) = 3, ceil(7 * 0.5) = ceil(3.5) = 4, weak = 0
      // 端数累積で weak=0 になるケース。仕様通り (件数下限を割らない)
      const items = Array.from({ length: 7 }, (_, i) => c(0.9 - i * 0.05, `i${i}`));
      const result = assignPercentileTiers(items);
      const tiers = result.map((r) => r.tier);
      expect(tiers.filter((t) => t === 'strong')).toHaveLength(3);
      expect(tiers.filter((t) => t === 'medium')).toHaveLength(4);
      expect(tiers.filter((t) => t === 'weak')).toHaveLength(0);
    });

    it('スコア降順に並び替わって返る', () => {
      // ランダム順で渡しても、スコア降順で返る
      const items = [c(0.2, 'a'), c(0.9, 'b'), c(0.5, 'c'), c(0.1, 'd'), c(0.7, 'e'), c(0.3, 'f')];
      const result = assignPercentileTiers(items);
      expect(result.map((r) => r.label)).toEqual(['b', 'e', 'c', 'f', 'a', 'd']);
    });
  });

  describe('ABSOLUTE_FLOOR_FOR_STRONG ハイブリッド (誤誘導防止)', () => {
    it('全候補が低スコアの場合、上位 30% でも strong に昇格しない (medium に降格)', () => {
      // 全候補が ABSOLUTE_FLOOR (0.05) 未満
      const items = Array.from({ length: 10 }, (_, i) => c(0.04 - i * 0.003, `i${i}`));
      const result = assignPercentileTiers(items);
      // strong は 0 件 (絶対下限を満たさないため medium に降格)
      expect(result.filter((r) => r.tier === 'strong')).toHaveLength(0);
      // 上位 30% 分が medium に降格、続く 50% 分は medium、合計 8 件 medium
      // 残り 2 件は weak
      expect(result.filter((r) => r.tier === 'medium')).toHaveLength(8);
      expect(result.filter((r) => r.tier === 'weak')).toHaveLength(2);
    });

    it('混在ケース: 上位は floor 以上で strong、floor 未満は medium に降格', () => {
      // 上位 3 件は floor 以上、後続は floor 未満
      const items = [
        c(0.9, 'a'),
        c(0.7, 'b'),
        c(0.5, 'c'),
        c(0.04, 'd'), // floor 未満だが上位 30% に該当 → medium 降格は不要 (% で medium 区域)
        c(0.03, 'e'),
        c(0.02, 'f'),
        c(0.01, 'g'),
        c(0.005, 'h'),
        c(0.003, 'i'),
        c(0.001, 'j'),
      ];
      const result = assignPercentileTiers(items);
      // ceil(10 * 0.3) = 3 → 上位 3 件 strong (a, b, c は全員 floor 以上 ✓)
      // ceil(10 * 0.5) = 5 → 続く 5 件 medium (d, e, f, g, h)
      // 残り 2 件 weak (i, j)
      expect(result.filter((r) => r.tier === 'strong').map((r) => r.label)).toEqual(['a', 'b', 'c']);
      expect(result.filter((r) => r.tier === 'medium').map((r) => r.label)).toEqual([
        'd',
        'e',
        'f',
        'g',
        'h',
      ]);
      expect(result.filter((r) => r.tier === 'weak').map((r) => r.label)).toEqual(['i', 'j']);
    });

    it('上位 30% のうち一部が floor 未満: floor 未満分のみ medium に降格', () => {
      // 上位 30% (= 3 件) のうち 2 件が floor 以上、1 件が floor 未満
      const items = [
        c(0.9, 'a'),
        c(0.5, 'b'),
        c(0.04, 'c'), // 上位 30% に入るが floor 未満 → medium に降格
        c(0.03, 'd'),
        c(0.02, 'e'),
        c(0.01, 'f'),
        c(0.005, 'g'),
        c(0.003, 'h'),
        c(0.002, 'i'),
        c(0.001, 'j'),
      ];
      const result = assignPercentileTiers(items);
      // strong は a, b の 2 件のみ (c は floor 未満なので medium 降格)
      expect(result.filter((r) => r.tier === 'strong').map((r) => r.label)).toEqual(['a', 'b']);
      // medium は c (降格) + d, e, f, g, h = 6 件
      expect(result.filter((r) => r.tier === 'medium').map((r) => r.label)).toEqual([
        'c',
        'd',
        'e',
        'f',
        'g',
        'h',
      ]);
      // weak は残り 2 件
      expect(result.filter((r) => r.tier === 'weak').map((r) => r.label)).toEqual(['i', 'j']);
    });
  });

  describe('入力配列の不変性', () => {
    it('入力配列を破壊しない (新しい配列を返す)', () => {
      const original = [c(0.5, 'a'), c(0.3, 'b'), c(0.1, 'c'), c(0.05, 'd'), c(0.04, 'e'), c(0.03, 'f')];
      const beforeOrder = original.map((c) => c.label);
      const result = assignPercentileTiers(original);
      // 入力の順序は破壊されない
      expect(original.map((c) => c.label)).toEqual(beforeOrder);
      expect(result).not.toBe(original);
    });
  });

  describe('P-1 設計値の整合性', () => {
    it('SUGGESTION_TIER_PERCENTILE_STRONG_RATIO は 0.3 (上位 30%)', () => {
      expect(SUGGESTION_TIER_PERCENTILE_STRONG_RATIO).toBe(0.3);
    });

    it('SUGGESTION_TIER_PERCENTILE_MEDIUM_RATIO は 0.5 (中段 50%)', () => {
      expect(SUGGESTION_TIER_PERCENTILE_MEDIUM_RATIO).toBe(0.5);
    });

    it('SUGGESTION_TIER_ABSOLUTE_FLOOR_FOR_STRONG は 0.05 (誤誘導防止)', () => {
      expect(SUGGESTION_TIER_ABSOLUTE_FLOOR_FOR_STRONG).toBe(0.05);
    });

    it('SUGGESTION_TIER_PERCENTILE_FALLBACK_THRESHOLD は 5 (絶対閾値フォールバック境界)', () => {
      expect(SUGGESTION_TIER_PERCENTILE_FALLBACK_THRESHOLD).toBe(5);
    });

    it('strong 比率 + medium 比率 + weak 比率 = 1.0', () => {
      expect(
        SUGGESTION_TIER_PERCENTILE_STRONG_RATIO +
          SUGGESTION_TIER_PERCENTILE_MEDIUM_RATIO +
          0.2,
      ).toBeCloseTo(1.0);
    });
  });
});
