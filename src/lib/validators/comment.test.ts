import { describe, it, expect } from 'vitest';
import {
  createCommentSchema,
  updateCommentSchema,
  COMMENT_ENTITY_TYPES,
} from './comment';

const validUuid = '00000000-0000-4000-8000-000000000001';

describe('createCommentSchema', () => {
  it('有効な入力を受け入れる', () => {
    expect(
      createCommentSchema.safeParse({
        entityType: 'issue',
        entityId: validUuid,
        content: 'こんにちは',
      }).success,
    ).toBe(true);
  });

  it('content は trim 後 1 文字以上必要 (空白のみは拒否)', () => {
    expect(
      createCommentSchema.safeParse({
        entityType: 'issue',
        entityId: validUuid,
        content: '   \n\t  ',
      }).success,
    ).toBe(false);
  });

  it('content は trim される (両端の空白を除去)', () => {
    const r = createCommentSchema.safeParse({
      entityType: 'issue',
      entityId: validUuid,
      content: '  hi  ',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.content).toBe('hi');
  });

  it('2001 文字は拒否する (上限 2000)', () => {
    expect(
      createCommentSchema.safeParse({
        entityType: 'issue',
        entityId: validUuid,
        content: 'a'.repeat(2001),
      }).success,
    ).toBe(false);
  });

  it('entityType は enum 外を拒否', () => {
    expect(
      createCommentSchema.safeParse({
        entityType: 'memo', // memo は対象外 (Comment 機能は 7 entity 限定)
        entityId: validUuid,
        content: 'x',
      }).success,
    ).toBe(false);
  });

  it('entityId は uuid 形式を要求', () => {
    expect(
      createCommentSchema.safeParse({
        entityType: 'issue',
        entityId: 'not-a-uuid',
        content: 'x',
      }).success,
    ).toBe(false);
  });

  it('全 7 entityType を受け入れる (Q1 全エンティティ)', () => {
    for (const t of COMMENT_ENTITY_TYPES) {
      const r = createCommentSchema.safeParse({
        entityType: t,
        entityId: validUuid,
        content: 'x',
      });
      expect(r.success).toBe(true);
    }
  });
});

describe('updateCommentSchema', () => {
  it('content のみ受け取り、その他は無視', () => {
    const r = updateCommentSchema.safeParse({
      content: 'updated',
      // 想定外フィールドは zod デフォルトで無視 (strict なら拒否)
      entityType: 'issue',
    });
    expect(r.success).toBe(true);
  });

  it('content 空は拒否', () => {
    expect(updateCommentSchema.safeParse({ content: '' }).success).toBe(false);
  });
});
