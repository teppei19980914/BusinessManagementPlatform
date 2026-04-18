import { describe, it, expect } from 'vitest';
import { createAttachmentSchema, updateAttachmentSchema } from './attachment';

describe('createAttachmentSchema', () => {
  const validInput = {
    entityType: 'risk' as const,
    entityId: '550e8400-e29b-41d4-a716-446655440000',
    displayName: '設計書',
    url: 'https://example.com/doc',
  };

  it('有効な入力を受け入れる (slot デフォルトが general になる)', () => {
    const parsed = createAttachmentSchema.safeParse(validInput);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.slot).toBe('general');
    }
  });

  it('各エンティティ種別を受け入れる', () => {
    for (const et of ['project', 'task', 'estimate', 'risk', 'retrospective', 'knowledge']) {
      expect(createAttachmentSchema.safeParse({ ...validInput, entityType: et }).success).toBe(true);
    }
  });

  it('不正なエンティティ種別を拒否する', () => {
    expect(createAttachmentSchema.safeParse({ ...validInput, entityType: 'member' }).success).toBe(false);
  });

  it('entityId が UUID でない場合を拒否する', () => {
    expect(createAttachmentSchema.safeParse({ ...validInput, entityId: 'not-uuid' }).success).toBe(false);
  });

  it('空の表示名を拒否する', () => {
    expect(createAttachmentSchema.safeParse({ ...validInput, displayName: '' }).success).toBe(false);
  });

  it('表示名が 201 文字の場合を拒否する', () => {
    expect(
      createAttachmentSchema.safeParse({ ...validInput, displayName: 'a'.repeat(201) }).success,
    ).toBe(false);
  });

  it('URL が 2001 文字の場合を拒否する', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2000);
    expect(createAttachmentSchema.safeParse({ ...validInput, url: longUrl }).success).toBe(false);
  });

  // セキュリティ: XSS / ローカルファイル参照を防ぐため http(s) 以外は拒否する
  it('javascript: スキームを拒否する (XSS 対策)', () => {
    expect(createAttachmentSchema.safeParse({ ...validInput, url: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('data: スキームを拒否する (任意コンテンツ回避)', () => {
    expect(
      createAttachmentSchema.safeParse({
        ...validInput,
        url: 'data:text/html,<script>alert(1)</script>',
      }).success,
    ).toBe(false);
  });

  it('file: スキームを拒否する (ローカルファイル参照回避)', () => {
    expect(createAttachmentSchema.safeParse({ ...validInput, url: 'file:///etc/passwd' }).success).toBe(false);
  });

  it('空 URL を拒否する', () => {
    expect(createAttachmentSchema.safeParse({ ...validInput, url: '' }).success).toBe(false);
  });

  it('http:// も受け入れる (社内イントラの http サイト想定)', () => {
    expect(
      createAttachmentSchema.safeParse({ ...validInput, url: 'http://intranet.local/doc' }).success,
    ).toBe(true);
  });

  it('slot を明示指定できる', () => {
    const parsed = createAttachmentSchema.safeParse({ ...validInput, slot: 'primary' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.slot).toBe('primary');
    }
  });

  it('slot が 31 文字の場合を拒否する', () => {
    expect(createAttachmentSchema.safeParse({ ...validInput, slot: 'a'.repeat(31) }).success).toBe(false);
  });
});

describe('updateAttachmentSchema', () => {
  it('部分更新を受け入れる', () => {
    expect(updateAttachmentSchema.safeParse({ displayName: '新しい名前' }).success).toBe(true);
    expect(updateAttachmentSchema.safeParse({ url: 'https://new.example.com' }).success).toBe(true);
  });

  it('url を更新する場合も javascript: を拒否する', () => {
    expect(updateAttachmentSchema.safeParse({ url: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('空オブジェクトでも受け入れる (何も更新しない)', () => {
    expect(updateAttachmentSchema.safeParse({}).success).toBe(true);
  });
});
