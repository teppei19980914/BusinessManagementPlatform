import { z } from 'zod/v4';

// パスワードポリシー（設計書 DESIGN.md 9.4.2）
// - 10文字以上 / 128文字以下
// - 英大文字・英小文字・数字・記号のうち3種以上
// - 連続同一文字4文字以上は禁止
export const passwordSchema = z
  .string()
  .min(10, 'パスワードは10文字以上で入力してください')
  .max(128, 'パスワードは128文字以下で入力してください')
  .refine(
    (val) => {
      const types = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/];
      return types.filter((r) => r.test(val)).length >= 3;
    },
    '英大文字・英小文字・数字・記号のうち3種以上を含めてください',
  )
  .refine(
    (val) => !/(.)\1{3,}/.test(val),
    '同じ文字を4文字以上連続して使用できません',
  );

export const loginSchema = z.object({
  email: z.email('有効なメールアドレスを入力してください'),
  password: z.string().min(1, 'パスワードを入力してください'),
});

export const createUserSchema = z.object({
  name: z
    .string()
    .min(1, 'ユーザ名を入力してください')
    .max(100, 'ユーザ名は100文字以内で入力してください'),
  email: z.email('有効なメールアドレスを入力してください'),
  systemRole: z.enum(['admin', 'general']),
});

export const setupPasswordSchema = z
  .object({
    token: z.string().min(1, 'トークンが必要です'),
    password: passwordSchema,
    confirmPassword: z.string().min(1, '確認用パスワードを入力してください'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'パスワードが一致しません',
    path: ['confirmPassword'],
  });

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type SetupPasswordInput = z.infer<typeof setupPasswordSchema>;
