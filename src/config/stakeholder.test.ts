import { describe, it, expect } from 'vitest';
import {
  classifyStakeholderQuadrant,
  calcEngagementGap,
  deriveStakeholderPriority,
} from './master-data';

describe('classifyStakeholderQuadrant (Mendelow Power/Interest grid)', () => {
  it('影響度 >= 4 かつ 関心度 >= 4 → manage_closely', () => {
    expect(classifyStakeholderQuadrant(5, 5)).toBe('manage_closely');
    expect(classifyStakeholderQuadrant(4, 5)).toBe('manage_closely');
    expect(classifyStakeholderQuadrant(5, 4)).toBe('manage_closely');
    expect(classifyStakeholderQuadrant(4, 4)).toBe('manage_closely');
  });

  it('影響度 >= 4 かつ 関心度 < 4 → keep_satisfied', () => {
    expect(classifyStakeholderQuadrant(5, 3)).toBe('keep_satisfied');
    expect(classifyStakeholderQuadrant(4, 1)).toBe('keep_satisfied');
  });

  it('影響度 < 4 かつ 関心度 >= 4 → keep_informed', () => {
    expect(classifyStakeholderQuadrant(3, 5)).toBe('keep_informed');
    expect(classifyStakeholderQuadrant(1, 4)).toBe('keep_informed');
  });

  it('影響度 < 4 かつ 関心度 < 4 → monitor (中央値 3 は low 寄り)', () => {
    expect(classifyStakeholderQuadrant(3, 3)).toBe('monitor');
    expect(classifyStakeholderQuadrant(1, 1)).toBe('monitor');
    expect(classifyStakeholderQuadrant(2, 3)).toBe('monitor');
  });
});

describe('calcEngagementGap (PMBOK 13.1.2)', () => {
  it('同一なら 0', () => {
    expect(calcEngagementGap('neutral', 'neutral')).toBe(0);
    expect(calcEngagementGap('leading', 'leading')).toBe(0);
  });

  it('正の値: 強める方向の働きかけが必要', () => {
    expect(calcEngagementGap('unaware', 'leading')).toBe(4);
    expect(calcEngagementGap('neutral', 'supportive')).toBe(1);
    expect(calcEngagementGap('resistant', 'neutral')).toBe(1);
  });

  it('負の値: 抑える方向 (例: 過剰主導 → 支持的)', () => {
    expect(calcEngagementGap('leading', 'supportive')).toBe(-1);
    expect(calcEngagementGap('leading', 'unaware')).toBe(-4);
  });
});

// Phase D 要件 11/12 (2026-04-28): 優先度 (high/medium/low) は Mendelow 4 象限から
// 自動分類する。manage_closely → high、monitor → low、それ以外 → medium。
describe('deriveStakeholderPriority (Phase D)', () => {
  it('manage_closely (大×大) → high', () => {
    expect(deriveStakeholderPriority(5, 5)).toBe('high');
    expect(deriveStakeholderPriority(4, 4)).toBe('high');
  });

  it('keep_satisfied (大×小) → medium', () => {
    expect(deriveStakeholderPriority(5, 1)).toBe('medium');
    expect(deriveStakeholderPriority(4, 3)).toBe('medium');
  });

  it('keep_informed (小×大) → medium', () => {
    expect(deriveStakeholderPriority(1, 5)).toBe('medium');
    expect(deriveStakeholderPriority(3, 4)).toBe('medium');
  });

  it('monitor (小×小) → low (中央値 3 は low 寄り)', () => {
    expect(deriveStakeholderPriority(3, 3)).toBe('low');
    expect(deriveStakeholderPriority(1, 1)).toBe('low');
  });
});
