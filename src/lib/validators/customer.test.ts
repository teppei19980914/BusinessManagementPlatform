import { describe, it, expect } from 'vitest';
import { createCustomerSchema, updateCustomerSchema } from './customer';

describe('createCustomerSchema', () => {
  it('最小構成 (name のみ) でパスする', () => {
    const result = createCustomerSchema.safeParse({ name: '株式会社サンプル' });
    expect(result.success).toBe(true);
  });

  it('全フィールド入力でパスする', () => {
    const result = createCustomerSchema.safeParse({
      name: '株式会社サンプル',
      department: '情報システム部',
      contactPerson: '山田太郎',
      contactEmail: 'yamada@example.com',
      notes: '主要顧客',
    });
    expect(result.success).toBe(true);
  });

  it('name 空文字はエラー', () => {
    const result = createCustomerSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('name 未入力はエラー', () => {
    const result = createCustomerSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('name が 101 文字はエラー (上限 100)', () => {
    const result = createCustomerSchema.safeParse({ name: 'あ'.repeat(101) });
    expect(result.success).toBe(false);
  });

  it('name が 100 文字ちょうどはパス', () => {
    const result = createCustomerSchema.safeParse({ name: 'あ'.repeat(100) });
    expect(result.success).toBe(true);
  });

  it('contactEmail に不正なメール形式はエラー', () => {
    const result = createCustomerSchema.safeParse({
      name: 'C',
      contactEmail: 'not-an-email',
    });
    expect(result.success).toBe(false);
  });

  it('contactEmail に空文字は許容 (UI で未入力を意図)', () => {
    const result = createCustomerSchema.safeParse({ name: 'C', contactEmail: '' });
    expect(result.success).toBe(true);
  });

  it('contactEmail null は許容', () => {
    const result = createCustomerSchema.safeParse({ name: 'C', contactEmail: null });
    expect(result.success).toBe(true);
  });

  it('notes が 1001 文字はエラー (上限 1000)', () => {
    const result = createCustomerSchema.safeParse({ name: 'C', notes: 'x'.repeat(1001) });
    expect(result.success).toBe(false);
  });
});

describe('updateCustomerSchema', () => {
  it('全フィールド省略 (空オブジェクト) でもパス (部分更新)', () => {
    const result = updateCustomerSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('name のみの部分更新でパス', () => {
    const result = updateCustomerSchema.safeParse({ name: '改名後' });
    expect(result.success).toBe(true);
  });

  it('不正なメール形式は update でもエラー', () => {
    const result = updateCustomerSchema.safeParse({ contactEmail: 'invalid' });
    expect(result.success).toBe(false);
  });
});
