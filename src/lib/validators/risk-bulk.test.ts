import { describe, it, expect } from 'vitest';
import { bulkUpdateRisksSchema } from './risk-bulk';

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

describe('filterFingerprint は任意項目', () => {
  // Phase C 要件 18 (2026-04-28): フィルター必須要件は撤廃。
  // schema は filterFingerprint の値の有無を検証しない (空オブジェクトでも通る)。
  it('filterFingerprint が空オブジェクトでも schema 検証は成功', () => {
    const r = bulkUpdateRisksSchema.safeParse({
      ids: ['550e8400-e29b-41d4-a716-446655440000'],
      filterFingerprint: {},
      patch: { state: 'in_progress' },
    });
    expect(r.success).toBe(true);
  });
});
