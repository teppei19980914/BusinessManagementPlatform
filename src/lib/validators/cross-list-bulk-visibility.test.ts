import { describe, it, expect } from 'vitest';
import {
  bulkUpdateRetrospectiveVisibilitySchema,
  bulkUpdateKnowledgeVisibilitySchema,
  bulkUpdateMemoVisibilitySchema,
  isCrossListFilterApplied,
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

describe('isCrossListFilterApplied', () => {
  it('全項目空なら false', () => {
    expect(isCrossListFilterApplied({})).toBe(false);
  });

  it('keyword 指定 (trim 後 1 文字以上) で true', () => {
    expect(isCrossListFilterApplied({ keyword: 'a' })).toBe(true);
    expect(isCrossListFilterApplied({ keyword: ' a ' })).toBe(true);
  });

  it('keyword が空白のみなら false (trim 後 0 文字)', () => {
    expect(isCrossListFilterApplied({ keyword: '   ' })).toBe(false);
  });

  it('mineOnly=true なら true (「自分作成のみ」は意図的なフィルター)', () => {
    expect(isCrossListFilterApplied({ mineOnly: true })).toBe(true);
  });

  it('mineOnly=false 単独では false (UI 初期状態と同じ)', () => {
    expect(isCrossListFilterApplied({ mineOnly: false })).toBe(false);
  });
});
