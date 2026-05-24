import { describe, it, expect } from 'vitest';
import {
  bulkUpdateRetrospectiveVisibilitySchema,
  bulkUpdateKnowledgeVisibilitySchema,
  bulkUpdateMemoVisibilitySchema,
  bulkUpdateRiskVisibilitySchema,
} from './cross-list-bulk-visibility';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('bulkUpdateRetrospectiveVisibilitySchema', () => {
  const baseValid = {
    ids: [VALID_UUID],
    filterFingerprint: { keyword: 'foo' },
    visibility: 'draft' as const,
  };

  it('有効な入力を受け入れる', () => {
    expect(bulkUpdateRetrospectiveVisibilitySchema.safeParse(baseValid).success).toBe(true);
  });

  it('visibility=public も受理する', () => {
    expect(bulkUpdateRetrospectiveVisibilitySchema.safeParse({ ...baseValid, visibility: 'public' }).success).toBe(true);
  });

  it('visibility が "private" は拒否 (Retrospective は draft/public のみ)', () => {
    expect(bulkUpdateRetrospectiveVisibilitySchema.safeParse({ ...baseValid, visibility: 'private' }).success).toBe(false);
  });

  it('ids が空配列なら拒否', () => {
    expect(bulkUpdateRetrospectiveVisibilitySchema.safeParse({ ...baseValid, ids: [] }).success).toBe(false);
  });

  it('ids 上限 500 件超なら拒否', () => {
    const ids = Array.from({ length: 501 }, () => VALID_UUID);
    expect(bulkUpdateRetrospectiveVisibilitySchema.safeParse({ ...baseValid, ids }).success).toBe(false);
  });
});

describe('bulkUpdateKnowledgeVisibilitySchema', () => {
  it('visibility=draft / public のみ受理', () => {
    const base = { ids: [VALID_UUID], filterFingerprint: { keyword: 'a' } };
    expect(bulkUpdateKnowledgeVisibilitySchema.safeParse({ ...base, visibility: 'draft' }).success).toBe(true);
    expect(bulkUpdateKnowledgeVisibilitySchema.safeParse({ ...base, visibility: 'public' }).success).toBe(true);
    expect(bulkUpdateKnowledgeVisibilitySchema.safeParse({ ...base, visibility: 'private' }).success).toBe(false);
  });
});

describe('bulkUpdateMemoVisibilitySchema', () => {
  it('Memo は visibility=private / public のみ受理 (DB schema に準拠)', () => {
    const base = { ids: [VALID_UUID], filterFingerprint: { keyword: 'a' } };
    expect(bulkUpdateMemoVisibilitySchema.safeParse({ ...base, visibility: 'private' }).success).toBe(true);
    expect(bulkUpdateMemoVisibilitySchema.safeParse({ ...base, visibility: 'public' }).success).toBe(true);
    // Memo は draft が無い (Retrospective/Knowledge とは異なる値域)
    expect(bulkUpdateMemoVisibilitySchema.safeParse({ ...base, visibility: 'draft' }).success).toBe(false);
  });
});

// UI_PATTERNS §35 (2026-05-24): Risk/Issue の一括編集も visibility-only に統一。
// 旧 risk-bulk.ts の state+assigneeId+deadline 複合 patch は撤廃済。
describe('bulkUpdateRiskVisibilitySchema', () => {
  it('Risk/Issue は visibility=draft / public のみ受理 (DB schema に準拠)', () => {
    const base = { ids: [VALID_UUID], filterFingerprint: { keyword: 'a' } };
    expect(bulkUpdateRiskVisibilitySchema.safeParse({ ...base, visibility: 'draft' }).success).toBe(true);
    expect(bulkUpdateRiskVisibilitySchema.safeParse({ ...base, visibility: 'public' }).success).toBe(true);
    // Risk/Issue は private が無い (Memo とは異なる値域)
    expect(bulkUpdateRiskVisibilitySchema.safeParse({ ...base, visibility: 'private' }).success).toBe(false);
  });

  it('ids が空配列なら拒否', () => {
    expect(
      bulkUpdateRiskVisibilitySchema.safeParse({
        ids: [],
        filterFingerprint: {},
        visibility: 'public',
      }).success,
    ).toBe(false);
  });

  it('ids 上限 500 件超なら拒否', () => {
    expect(
      bulkUpdateRiskVisibilitySchema.safeParse({
        ids: Array.from({ length: 501 }, () => VALID_UUID),
        filterFingerprint: {},
        visibility: 'public',
      }).success,
    ).toBe(false);
  });

  it('旧 patch.state / patch.assigneeId / patch.deadline の複合フィールドは受理しない (上位スキーマが strict ではないが visibility が必須なので別経路は不可)', () => {
    // 旧形式 { ids, filterFingerprint, patch: { state } } では visibility が無く拒否される
    expect(
      bulkUpdateRiskVisibilitySchema.safeParse({
        ids: [VALID_UUID],
        filterFingerprint: {},
        patch: { state: 'resolved' },
      }).success,
    ).toBe(false);
  });
});

describe('filterFingerprint は任意項目', () => {
  // Phase C 要件 18 (2026-04-28): フィルター必須要件は撤廃。
  // schema は filterFingerprint の値の有無を検証しない (空オブジェクトでも通る)。
  it('filterFingerprint が空オブジェクトでも schema 検証は成功', () => {
    expect(
      bulkUpdateMemoVisibilitySchema.safeParse({
        ids: [VALID_UUID],
        filterFingerprint: {},
        visibility: 'public',
      }).success,
    ).toBe(true);
  });

  it('filterFingerprint に keyword/mineOnly があっても通る (UI 表示用)', () => {
    expect(
      bulkUpdateMemoVisibilitySchema.safeParse({
        ids: [VALID_UUID],
        filterFingerprint: { keyword: 'foo', mineOnly: true },
        visibility: 'public',
      }).success,
    ).toBe(true);
  });
});
