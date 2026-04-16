import { describe, it, expect } from 'vitest';
import { passwordSchema, loginSchema, createUserSchema, setupPasswordSchema } from './auth';

describe('passwordSchema', () => {
  it('10文字以上で3種以上の文字種を含むパスワードを受け入れる', () => {
    const result = passwordSchema.safeParse('Abcdef123!');
    expect(result.success).toBe(true);
  });

  it('10文字未満のパスワードを拒否する', () => {
    const result = passwordSchema.safeParse('Abc123!');
    expect(result.success).toBe(false);
  });

  it('文字種が2種以下のパスワードを拒否する（小文字+数字のみ）', () => {
    const result = passwordSchema.safeParse('abcdefghij1234');
    expect(result.success).toBe(false);
  });

  it('文字種が2種以下のパスワードを拒否する（小文字+大文字のみ）', () => {
    const result = passwordSchema.safeParse('AbcdefghijKLMN');
    expect(result.success).toBe(false);
  });

  it('3種の文字種（小文字+大文字+数字）を受け入れる', () => {
    const result = passwordSchema.safeParse('Abcdefgh12');
    expect(result.success).toBe(true);
  });

  it('3種の文字種（小文字+数字+記号）を受け入れる', () => {
    const result = passwordSchema.safeParse('abcdefg12!');
    expect(result.success).toBe(true);
  });

  it('連続同一文字4文字以上を拒否する', () => {
    const result = passwordSchema.safeParse('Abcd1111!xyz');
    expect(result.success).toBe(false);
  });

  it('連続同一文字3文字は許容する', () => {
    const result = passwordSchema.safeParse('Abcd111!xyz');
    expect(result.success).toBe(true);
  });

  it('128文字を超えるパスワードを拒否する', () => {
    const longPassword = 'A1!' + 'a'.repeat(126);
    const result = passwordSchema.safeParse(longPassword);
    expect(result.success).toBe(false);
  });

  it('128文字ちょうどのパスワードを受け入れる', () => {
    // 連続同一文字を避けて128文字を構成
    const base = 'A1!abcde';
    const password = base.repeat(16); // 128文字
    const result = passwordSchema.safeParse(password);
    expect(result.success).toBe(true);
  });

  it('空文字列を拒否する', () => {
    const result = passwordSchema.safeParse('');
    expect(result.success).toBe(false);
  });
});

describe('loginSchema', () => {
  it('有効なメールとパスワードを受け入れる', () => {
    const result = loginSchema.safeParse({
      email: 'user@example.com',
      password: 'password',
    });
    expect(result.success).toBe(true);
  });

  it('無効なメール形式を拒否する', () => {
    const result = loginSchema.safeParse({
      email: 'not-an-email',
      password: 'password',
    });
    expect(result.success).toBe(false);
  });

  it('空のパスワードを拒否する', () => {
    const result = loginSchema.safeParse({
      email: 'user@example.com',
      password: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('createUserSchema', () => {
  const validInput = {
    name: 'テストユーザ',
    email: 'test@example.com',
    systemRole: 'general' as const,
  };

  it('有効な入力を受け入れる（パスワードなし）', () => {
    const result = createUserSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('名前が空の場合を拒否する', () => {
    const result = createUserSchema.safeParse({ ...validInput, name: '' });
    expect(result.success).toBe(false);
  });

  it('名前が101文字の場合を拒否する', () => {
    const result = createUserSchema.safeParse({ ...validInput, name: 'a'.repeat(101) });
    expect(result.success).toBe(false);
  });

  it('無効なロールを拒否する', () => {
    const result = createUserSchema.safeParse({ ...validInput, systemRole: 'superadmin' });
    expect(result.success).toBe(false);
  });

  it('admin ロールを受け入れる', () => {
    const result = createUserSchema.safeParse({ ...validInput, systemRole: 'admin' });
    expect(result.success).toBe(true);
  });
});

describe('setupPasswordSchema', () => {
  const validInput = {
    token: 'abc123',
    password: 'Abcdefgh12!',
    confirmPassword: 'Abcdefgh12!',
  };

  it('有効な入力を受け入れる', () => {
    const result = setupPasswordSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('パスワード不一致を拒否する', () => {
    const result = setupPasswordSchema.safeParse({
      ...validInput,
      confirmPassword: 'DifferentPw1!',
    });
    expect(result.success).toBe(false);
  });

  it('トークンが空の場合を拒否する', () => {
    const result = setupPasswordSchema.safeParse({ ...validInput, token: '' });
    expect(result.success).toBe(false);
  });

  it('パスワードポリシーを適用する', () => {
    const result = setupPasswordSchema.safeParse({
      ...validInput,
      password: 'short',
      confirmPassword: 'short',
    });
    expect(result.success).toBe(false);
  });
});
