import { describe, it, expect } from 'vitest';
import { createMemoSchema, updateMemoSchema } from './memo';

describe('createMemoSchema', () => {
  const valid = {
    title: '調査メモ',
    content: '○○フレームワークの挙動調査結果',
  };

  it('有効な入力を受け入れる (visibility は省略で private)', () => {
    const parsed = createMemoSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.visibility).toBe('private');
    }
  });

  it('visibility を明示指定できる', () => {
    for (const v of ['private', 'public']) {
      expect(createMemoSchema.safeParse({ ...valid, visibility: v }).success).toBe(true);
    }
  });

  it('不正な visibility を拒否', () => {
    expect(createMemoSchema.safeParse({ ...valid, visibility: 'draft' }).success).toBe(false);
    expect(createMemoSchema.safeParse({ ...valid, visibility: 'project' }).success).toBe(false);
  });

  it('空タイトルを拒否', () => {
    expect(createMemoSchema.safeParse({ ...valid, title: '' }).success).toBe(false);
  });

  it('タイトル 151 文字を拒否', () => {
    expect(createMemoSchema.safeParse({ ...valid, title: 'a'.repeat(151) }).success).toBe(false);
  });

  // refactor/list-create-content-optional (2026-04-27 #6): 本文は任意化、空文字許容
  it('空本文を許容 (2026-04-27 仕様変更: 本文は任意)', () => {
    expect(createMemoSchema.safeParse({ ...valid, content: '' }).success).toBe(true);
  });

  it('本文 10001 文字を拒否', () => {
    expect(createMemoSchema.safeParse({ ...valid, content: 'a'.repeat(10001) }).success).toBe(false);
  });
});

describe('updateMemoSchema', () => {
  it('部分更新を受け入れる', () => {
    expect(updateMemoSchema.safeParse({ title: '変更後' }).success).toBe(true);
    expect(updateMemoSchema.safeParse({ visibility: 'public' }).success).toBe(true);
  });

  it('空オブジェクトでも受け入れる', () => {
    expect(updateMemoSchema.safeParse({}).success).toBe(true);
  });

  it('無効な visibility は拒否', () => {
    expect(updateMemoSchema.safeParse({ visibility: 'foo' }).success).toBe(false);
  });
});
