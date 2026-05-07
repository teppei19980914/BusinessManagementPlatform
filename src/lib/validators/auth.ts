import { z } from 'zod/v4';
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_REQUIRED_CHAR_TYPE_COUNT,
  PASSWORD_MAX_CONSECUTIVE_SAME_CHARS,
  NAME_MAX_LENGTH,
} from '@/config';

// パスワードポリシー（設計書 DESIGN.md §9.4.2 / 定数は src/config/security.ts）
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `パスワードは${PASSWORD_MIN_LENGTH}文字以上で入力してください`)
  .max(PASSWORD_MAX_LENGTH, `パスワードは${PASSWORD_MAX_LENGTH}文字以下で入力してください`)
  .refine(
    (val) => {
      const types = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/];
      return types.filter((r) => r.test(val)).length >= PASSWORD_REQUIRED_CHAR_TYPE_COUNT;
    },
    `英大文字・英小文字・数字・記号のうち${PASSWORD_REQUIRED_CHAR_TYPE_COUNT}種以上を含めてください`,
  )
  .refine(
    (val) => {
      // 同一文字が PASSWORD_MAX_CONSECUTIVE_SAME_CHARS 文字以上連続していないか
      const re = new RegExp(`(.)\\1{${PASSWORD_MAX_CONSECUTIVE_SAME_CHARS - 1},}`);
      return !re.test(val);
    },
    `同じ文字を${PASSWORD_MAX_CONSECUTIVE_SAME_CHARS}文字以上連続して使用できません`,
  );

export const loginSchema = z.object({
  email: z.email('有効なメールアドレスを入力してください'),
  password: z.string().min(1, 'パスワードを入力してください'),
});

export const createUserSchema = z.object({
  name: z
    .string()
    .min(1, 'ユーザ名を入力してください')
    .max(NAME_MAX_LENGTH, `ユーザ名は${NAME_MAX_LENGTH}文字以内で入力してください`),
  email: z.email('有効なメールアドレスを入力してください'),
  // PR-X1 (2026-05-07): super_admin を validator では許容するが、API route 側で
  //   「呼出者が super_admin でない限り super_admin への昇格は不可」のガードを追加。
  //   詳細: docs/roadmap/ROLE_REFACTORING_PLAN.md §3.1
  systemRole: z.enum(['super_admin', 'admin', 'general']),
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
