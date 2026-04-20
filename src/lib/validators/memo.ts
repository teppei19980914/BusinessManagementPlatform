import { z } from 'zod/v4';

/**
 * メモの公開範囲 (PR #70)。
 *   - 'private' (既定): 作成者のみ閲覧可
 *   - 'public'        : 全ログインユーザが「全メモ」画面で閲覧可 (編集/削除は作成者のみ)
 */
export const MEMO_VISIBILITIES = ['private', 'public'] as const;
export type MemoVisibility = (typeof MEMO_VISIBILITIES)[number];

/**
 * メモ作成スキーマ。
 * タグは持たせない (PR #70 要件): メモは業務知見の一時置き場で、共有資産化判断は人間の目で行う。
 */
export const createMemoSchema = z.object({
  title: z.string().min(1, 'タイトルを入力してください').max(150),
  content: z.string().min(1, '本文を入力してください').max(10000),
  visibility: z.enum(MEMO_VISIBILITIES).default('private'),
});

export const updateMemoSchema = createMemoSchema.partial();

export type CreateMemoInput = z.infer<typeof createMemoSchema>;
export type UpdateMemoInput = z.infer<typeof updateMemoSchema>;
