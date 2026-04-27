import { describe, it, expect } from 'vitest';
import { bulkUpdateRisksSchema, isFilterApplied } from './risk-bulk';

describe('bulkUpdateRisksSchema', () => {
  const baseValid = {
    ids: ['550e8400-e29b-41d4-a716-446655440000'],
    filterFingerprint: { type: 'risk' as const },
    patch: { state: 'in_progress' as const },
  };

  it('有効な入力を受け入れる', () => {
    expect(bulkUpdateRisksSchema.safeParse(baseValid).success).toBe(true);
  });

  it('ids が空配列なら拒否', () => {
    expect(bulkUpdateRisksSchema.safeParse({ ...baseValid, ids: [] }).success).toBe(false);
  });

  it('ids が UUID でないなら拒否', () => {
    expect(bulkUpdateRisksSchema.safeParse({ ...baseValid, ids: ['not-uuid'] }).success).toBe(false);
  });

  it('ids が 501 件なら拒否 (上限 500)', () => {
    const ids = Array.from({ length: 501 }, () => '550e8400-e29b-41d4-a716-446655440000');
    expect(bulkUpdateRisksSchema.safeParse({ ...baseValid, ids }).success).toBe(false);
  });

  it('patch がすべて省略 (= no-op) なら拒否', () => {
    const r = bulkUpdateRisksSchema.safeParse({ ...baseValid, patch: {} });
    expect(r.success).toBe(false);
  });

  it('patch.assigneeId=null は受理する (担当者クリア)', () => {
    const r = bulkUpdateRisksSchema.safeParse({ ...baseValid, patch: { assigneeId: null } });
    expect(r.success).toBe(true);
  });

  it('patch.deadline=null は受理する (期限クリア)', () => {
    const r = bulkUpdateRisksSchema.safeParse({ ...baseValid, patch: { deadline: null } });
    expect(r.success).toBe(true);
  });

  it('patch.deadline が YYYY-MM-DD でないなら拒否', () => {
    const r = bulkUpdateRisksSchema.safeParse({ ...baseValid, patch: { deadline: '2026/01/01' } });
    expect(r.success).toBe(false);
  });

  it('patch.state が enum 外なら拒否', () => {
    const r = bulkUpdateRisksSchema.safeParse({ ...baseValid, patch: { state: 'closed' } });
    expect(r.success).toBe(false);
  });
});

describe('isFilterApplied', () => {
  it('全項目空なら false (= フィルター無し、全件更新の事故防止に使う)', () => {
    expect(isFilterApplied({})).toBe(false);
  });

  it('type 指定 (タブ選択) のみで true (タブは暗黙のフィルターとしてカウント)', () => {
    expect(isFilterApplied({ type: 'risk' })).toBe(true);
  });

  it('state 指定で true', () => {
    expect(isFilterApplied({ state: 'open' })).toBe(true);
  });

  it('impact 指定で true', () => {
    expect(isFilterApplied({ impact: 'high' })).toBe(true);
  });

  it('assigneeId 指定で true', () => {
    expect(isFilterApplied({ assigneeId: '550e8400-e29b-41d4-a716-446655440000' })).toBe(true);
  });

  it('keyword が空白のみなら false (= trim 後 0 文字)', () => {
    expect(isFilterApplied({ keyword: '   ' })).toBe(false);
  });

  it('keyword が trim 後 1 文字以上なら true', () => {
    expect(isFilterApplied({ keyword: ' a ' })).toBe(true);
  });
});
