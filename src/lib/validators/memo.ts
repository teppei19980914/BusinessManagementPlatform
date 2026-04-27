import { z } from 'zod/v4';
import { TITLE_MAX_LENGTH, MEMO_CONTENT_MAX_LENGTH } from '@/config';

/**
 * メモの公開範囲 (PR #70)。
 *   - 'private' (既定): 作成者のみ閲覧可
 *   - 'public'        : 全ログインユーザが「全メモ」画面で閲覧可 (編集/削除は作成者のみ)
 *
 * モジュール内限定。外部 API は `createMemoSchema` / `updateMemoSchema` を通じて型を公開する。
 */
const MEMO_VISIBILITIES = ['private', 'public'] as const;

/**
 * メモ作成スキーマ。
 * タグは持たせない (PR #70 要件): メモは業務知見の一時置き場で、共有資産化判断は人間の目で行う。
 */
export const createMemoSchema = z.object({
  title: z.string().min(1, 'タイトルを入力してください').max(TITLE_MAX_LENGTH),
  // refactor/list-create-content-optional (2026-04-27 ユーザ要望 #6):
  // タイトルは必須維持、本文は任意化 (空文字許容)。
  content: z.string().max(MEMO_CONTENT_MAX_LENGTH),
  visibility: z.enum(MEMO_VISIBILITIES).default('private'),
});

export const updateMemoSchema = createMemoSchema.partial();

export type CreateMemoInput = z.infer<typeof createMemoSchema>;
export type UpdateMemoInput = z.infer<typeof updateMemoSchema>;
