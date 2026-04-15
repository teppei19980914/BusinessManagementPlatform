import { describe, it, expect } from 'vitest';
import { changePasswordSchema } from './password';

describe('changePasswordSchema', () => {
  it('有効な入力を受け入れる', () => {
    expect(changePasswordSchema.safeParse({
      currentPassword: 'OldPass123!',
      newPassword: 'NewPass456!',
    }).success).toBe(true);
  });

  it('現在のパスワードが空の場合を拒否する', () => {
    expect(changePasswordSchema.safeParse({
      currentPassword: '',
      newPassword: 'NewPass456!',
    }).success).toBe(false);
  });

  it('新パスワードがポリシー違反の場合を拒否する', () => {
    expect(changePasswordSchema.safeParse({
      currentPassword: 'OldPass123!',
      newPassword: 'short',
    }).success).toBe(false);
  });

  it('新パスワードが文字種不足の場合を拒否する', () => {
    expect(changePasswordSchema.safeParse({
      currentPassword: 'OldPass123!',
      newPassword: 'abcdefghij1234',
    }).success).toBe(false);
  });
});
