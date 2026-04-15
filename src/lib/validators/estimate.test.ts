import { describe, it, expect } from 'vitest';
import { createEstimateSchema } from './estimate';

describe('createEstimateSchema', () => {
  const validInput = {
    itemName: '基本設計',
    category: 'design' as const,
    devMethod: 'scratch' as const,
    estimatedEffort: 40,
    effortUnit: 'person_hour' as const,
    rationale: '過去の類似案件実績（30h）+ バッファ10h',
  };

  it('有効な入力を受け入れる', () => {
    expect(createEstimateSchema.safeParse(validInput).success).toBe(true);
  });

  it('項目名が空の場合を拒否する', () => {
    expect(createEstimateSchema.safeParse({ ...validInput, itemName: '' }).success).toBe(false);
  });

  it('見積根拠が空の場合を拒否する', () => {
    expect(createEstimateSchema.safeParse({ ...validInput, rationale: '' }).success).toBe(false);
  });

  it('見積工数が0以下の場合を拒否する', () => {
    expect(createEstimateSchema.safeParse({ ...validInput, estimatedEffort: 0 }).success).toBe(false);
    expect(createEstimateSchema.safeParse({ ...validInput, estimatedEffort: -1 }).success).toBe(false);
  });

  it('有効な単位を受け入れる', () => {
    expect(createEstimateSchema.safeParse({ ...validInput, effortUnit: 'person_hour' }).success).toBe(true);
    expect(createEstimateSchema.safeParse({ ...validInput, effortUnit: 'person_day' }).success).toBe(true);
  });

  it('無効な単位を拒否する', () => {
    expect(createEstimateSchema.safeParse({ ...validInput, effortUnit: 'hours' }).success).toBe(false);
  });

  it('見積根拠が3001文字の場合を拒否する', () => {
    expect(createEstimateSchema.safeParse({ ...validInput, rationale: 'a'.repeat(3001) }).success).toBe(false);
  });
});
